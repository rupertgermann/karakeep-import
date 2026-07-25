use std::{env, fs, path::PathBuf};

use serde_json::Value;

fn main() {
    let manifest_dir =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("Cargo manifest directory"));
    let bundle_manifest = manifest_dir.join("../vendor/fieldtheory/manifest.json");
    let migrations = manifest_dir.join("migrations");
    let ledger_source = manifest_dir.join("src/ledger.rs");
    println!("cargo:rerun-if-changed={}", bundle_manifest.display());
    println!("cargo:rerun-if-changed={}", migrations.display());
    println!("cargo:rerun-if-changed={}", ledger_source.display());

    let manifest: Value = serde_json::from_str(
        &fs::read_to_string(&bundle_manifest).expect("read pinned Field Theory manifest"),
    )
    .expect("parse pinned Field Theory manifest");
    let field_theory = manifest_version(&manifest, &["fieldTheory", "version"]);
    let node = manifest_version(&manifest, &["node", "version"]);
    let schema = initialized_schema_version(&migrations, &ledger_source);

    println!("cargo:rustc-env=KARAKEEP_FIELD_THEORY_VERSION={field_theory}");
    println!("cargo:rustc-env=KARAKEEP_NODE_VERSION={node}");
    println!("cargo:rustc-env=KARAKEEP_SCHEMA_VERSION={schema}");
    tauri_build::build();
}

fn manifest_version(manifest: &Value, path: &[&str]) -> String {
    let value = path
        .iter()
        .try_fold(manifest, |value, key| value.get(key))
        .and_then(Value::as_str)
        .expect("pinned component version");
    if value.is_empty() || value.trim() != value || value.contains(['\r', '\n']) {
        panic!("pinned component version is invalid");
    }
    value.to_owned()
}

fn initialized_schema_version(migrations: &PathBuf, ledger_source: &PathBuf) -> usize {
    let mut files = fs::read_dir(migrations)
        .expect("read migrations directory")
        .map(|entry| entry.expect("read migration entry").path())
        .filter(|path| path.extension().is_some_and(|extension| extension == "sql"))
        .collect::<Vec<_>>();
    files.sort();
    assert!(
        !files.is_empty(),
        "at least one ledger migration is required"
    );

    let ledger = fs::read_to_string(ledger_source).expect("read delivery ledger source");
    for file in &files {
        let name = file
            .file_name()
            .and_then(|name| name.to_str())
            .expect("UTF-8 migration filename");
        let include = format!("include_str!(\"../migrations/{name}\")");
        assert!(
            ledger.contains(&include),
            "delivery ledger does not initialize migration {name}"
        );
    }
    let included = ledger.matches("include_str!(\"../migrations/").count();
    assert_eq!(
        included,
        files.len(),
        "delivery ledger migration list differs from checked-in migrations"
    );
    files.len()
}
