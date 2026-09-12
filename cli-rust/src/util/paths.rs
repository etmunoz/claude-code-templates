//! Path resolution helpers: home dir, settings-location mapping, enterprise
//! managed-settings directories, and relative-path computation for tracking.

use directories::UserDirs;
use std::path::{Path, PathBuf};

/// Resolve the user's home directory (equivalent to `os.homedir()`).
pub fn home_dir() -> PathBuf {
    UserDirs::new()
        .map(|d| d.home_dir().to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."))
}

/// A resolved install location for a setting/hook: the directory the settings
/// file lives in and the filename. Mirrors the branching in
/// `installIndividualSetting` / `installIndividualHook`.
pub struct ResolvedLocation {
    /// Base dir the additional files resolve against (`currentTargetDir`).
    pub current_target_dir: PathBuf,
    /// Absolute path of the settings JSON file to merge into.
    pub settings_file: PathBuf,
}

/// Map a location keyword (`user`/`project`/`local`/`enterprise`) to concrete
/// paths, given the project `target_dir`. Returns `None` for unsupported
/// enterprise platforms (Node falls back to user settings in that case — the
/// caller handles the fallback).
pub fn resolve_location(location: &str, target_dir: &Path) -> ResolvedLocation {
    match location {
        "user" => {
            let dir = home_dir();
            ResolvedLocation {
                settings_file: dir.join(".claude").join("settings.json"),
                current_target_dir: dir,
            }
        }
        "project" => ResolvedLocation {
            current_target_dir: target_dir.to_path_buf(),
            settings_file: target_dir.join(".claude").join("settings.json"),
        },
        "enterprise" => {
            if let Some(dir) = enterprise_dir() {
                let file = dir.join("managed-settings.json");
                ResolvedLocation {
                    current_target_dir: dir,
                    settings_file: file,
                }
            } else {
                // Fallback to user settings (matches Node's else branch).
                let dir = home_dir();
                ResolvedLocation {
                    settings_file: dir.join(".claude").join("settings.json"),
                    current_target_dir: dir,
                }
            }
        }
        // "local" and any unknown value default to local settings.
        _ => ResolvedLocation {
            current_target_dir: target_dir.to_path_buf(),
            settings_file: target_dir.join(".claude").join("settings.local.json"),
        },
    }
}

/// Enterprise managed-settings directory per platform.
/// macOS: `/Library/Application Support/ClaudeCode`
/// Linux/WSL: `/etc/claude-code`
/// Windows: `C:\ProgramData\ClaudeCode`
fn enterprise_dir() -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        Some(PathBuf::from("/Library/Application Support/ClaudeCode"))
    } else if cfg!(target_os = "linux") {
        Some(PathBuf::from("/etc/claude-code"))
    } else if cfg!(target_os = "windows") {
        Some(PathBuf::from("C:\\ProgramData\\ClaudeCode"))
    } else {
        None
    }
}

/// Resolve an "additional file" path declared by a downloaded component,
/// confining it to `current_target_dir`.
///
/// SECURITY: components are untrusted third-party content. A malicious
/// component could otherwise use `~`, an absolute path, or `../` traversal to
/// write (and mark executable) files anywhere on disk — e.g. `~/.bashrc`,
/// `~/.ssh/authorized_keys`, or a cron file. So `~` is NOT expanded, and the
/// resolved path must stay inside `current_target_dir`.
///
/// Returns `Err` describing the rejected path when it would escape the target.
pub fn resolve_additional_file(
    file_path: &str,
    current_target_dir: &Path,
) -> Result<PathBuf, String> {
    if file_path.is_empty() {
        return Err("empty component file path".to_string());
    }
    // Reject home-directory expansion outright.
    if file_path == "~" || file_path.starts_with("~/") || file_path.starts_with("~\\") {
        return Err(format!(
            "refusing to write outside the project (home-directory path): {file_path}"
        ));
    }

    let base = current_target_dir;
    let joined = base.join(file_path);

    // Normalize `.`/`..` lexically (the path may not exist yet, so we cannot
    // use `canonicalize`) and ensure the result stays under `base`.
    let mut normalized = PathBuf::new();
    for comp in joined.components() {
        use std::path::Component;
        match comp {
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err(format!(
                        "refusing to write outside the project (path traversal): {file_path}"
                    ));
                }
            }
            Component::CurDir => {}
            other => normalized.push(other.as_os_str()),
        }
    }
    if !normalized.starts_with(base) {
        return Err(format!(
            "refusing to write outside the project (path traversal): {file_path}"
        ));
    }
    Ok(normalized)
}

/// Best-effort equivalent of `path.relative(from, to)` for tracking metadata.
pub fn relative_path(from: &Path, to: &Path) -> String {
    pathdiff::diff_paths(to, from)
        .unwrap_or_else(|| to.to_path_buf())
        .to_string_lossy()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn local_location_uses_settings_local_json() {
        let target = PathBuf::from("/tmp/proj");
        let r = resolve_location("local", &target);
        assert_eq!(r.settings_file, target.join(".claude/settings.local.json"));
        assert_eq!(r.current_target_dir, target);
    }

    #[test]
    fn project_location_uses_settings_json() {
        let target = PathBuf::from("/tmp/proj");
        let r = resolve_location("project", &target);
        assert_eq!(r.settings_file, target.join(".claude/settings.json"));
    }

    #[test]
    fn user_location_resolves_under_home() {
        let r = resolve_location("user", Path::new("/tmp/proj"));
        assert_eq!(r.settings_file, home_dir().join(".claude/settings.json"));
        assert_eq!(r.current_target_dir, home_dir());
    }

    #[test]
    fn additional_file_rejects_tilde_home_expansion() {
        // SECURITY: `~` must NOT expand — components may not target $HOME.
        assert!(resolve_additional_file("~/.bashrc", Path::new("/tmp/proj")).is_err());
        assert!(resolve_additional_file("~", Path::new("/tmp/proj")).is_err());
    }

    #[test]
    fn additional_file_resolves_relative_against_target() {
        let resolved =
            resolve_additional_file(".claude/scripts/s.py", Path::new("/tmp/proj")).unwrap();
        assert_eq!(resolved, PathBuf::from("/tmp/proj/.claude/scripts/s.py"));
    }

    #[test]
    fn additional_file_rejects_parent_traversal() {
        // SECURITY: `../` escape out of the target dir must be refused.
        assert!(
            resolve_additional_file("../../../../etc/cron.d/x", Path::new("/tmp/proj")).is_err()
        );
        assert!(resolve_additional_file("/etc/passwd", Path::new("/tmp/proj")).is_err());
    }

    #[test]
    fn relative_path_computes_dotdot() {
        let rel = relative_path(Path::new("/a/b"), Path::new("/a/c/d"));
        assert_eq!(rel, "../c/d");
    }
}
