use serde::Serialize;

pub const KARAKEEP_BASELINE_VERSION: &str = "0.32.0";
pub const NOT_BUNDLED: &str = "not bundled";
pub const SCHEMA_NOT_INITIALIZED: &str = "not initialized";

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentVersions {
    pub app: String,
    pub field_theory: String,
    pub node: String,
    pub schema: String,
    pub karakeep_baseline: String,
}

impl ComponentVersions {
    pub fn new(
        app: impl Into<String>,
        field_theory: impl Into<String>,
        node: impl Into<String>,
        schema: impl Into<String>,
    ) -> Self {
        Self {
            app: app.into(),
            field_theory: field_theory.into(),
            node: node.into(),
            schema: schema.into(),
            karakeep_baseline: KARAKEEP_BASELINE_VERSION.to_owned(),
        }
    }

    pub fn current() -> Self {
        Self::from_build_metadata(
            env!("CARGO_PKG_VERSION"),
            Some(env!("KARAKEEP_FIELD_THEORY_VERSION")),
            Some(env!("KARAKEEP_NODE_VERSION")),
            Some(env!("KARAKEEP_SCHEMA_VERSION")),
        )
    }

    pub fn from_build_metadata(
        app: impl Into<String>,
        field_theory: Option<&str>,
        node: Option<&str>,
        schema: Option<&str>,
    ) -> Self {
        Self::new(
            app,
            field_theory.unwrap_or(NOT_BUNDLED),
            node.unwrap_or(NOT_BUNDLED),
            schema.unwrap_or(SCHEMA_NOT_INITIALIZED),
        )
    }
}
