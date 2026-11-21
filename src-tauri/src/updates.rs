use serde::Serialize;

pub const GITHUB_RELEASES_URL: &str = "https://github.com/rupertgermann/karakeep-import/releases";

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualUpdateCheckResult {
    pub requested_by_user: bool,
    pub release_page: &'static str,
    pub downloads_update: bool,
    pub executes_update: bool,
}

pub fn manual_update_check() -> ManualUpdateCheckResult {
    ManualUpdateCheckResult {
        requested_by_user: true,
        release_page: GITHUB_RELEASES_URL,
        downloads_update: false,
        executes_update: false,
    }
}
