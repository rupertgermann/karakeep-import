use serde_json::Value;

pub const REDACTED: &str = "[REDACTED]";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DiagnosticSurface {
    UiState,
    Log,
    Sqlite,
    Diagnostics,
    Arguments,
}

#[derive(Clone, Default)]
pub struct SecretRedactor {
    forbidden_values: Vec<String>,
}

impl SecretRedactor {
    pub fn new<I, S>(forbidden_values: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let mut forbidden_values = forbidden_values
            .into_iter()
            .map(Into::into)
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>();
        forbidden_values.sort();
        forbidden_values.dedup();
        forbidden_values.sort_by_key(|value| std::cmp::Reverse(value.len()));

        Self { forbidden_values }
    }

    pub fn redact_text(&self, _surface: DiagnosticSurface, input: &str) -> String {
        self.forbidden_values
            .iter()
            .fold(input.to_owned(), |redacted, forbidden| {
                redacted.replace(forbidden, REDACTED)
            })
    }

    pub fn redact_value(&self, surface: DiagnosticSurface, input: &Value) -> Value {
        match input {
            Value::Array(values) => Value::Array(
                values
                    .iter()
                    .map(|value| self.redact_value(surface, value))
                    .collect(),
            ),
            Value::Object(values) => Value::Object(
                values
                    .iter()
                    .map(|(key, value)| {
                        let value = if is_sensitive_key(key) {
                            Value::String(REDACTED.to_owned())
                        } else {
                            self.redact_value(surface, value)
                        };
                        (key.clone(), value)
                    })
                    .collect(),
            ),
            Value::String(value) => Value::String(self.redact_text(surface, value)),
            value => value.clone(),
        }
    }
}

fn is_sensitive_key(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();

    normalized.contains("apikey")
        || normalized.contains("authorization")
        || normalized.contains("cookie")
        || normalized.contains("password")
        || normalized.contains("secret")
        || normalized.contains("session")
        || matches!(
            normalized.as_str(),
            "authtoken" | "ct0" | "token" | "bearer"
        )
}
