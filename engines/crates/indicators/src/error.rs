//! Engine errors, reported through the ABI as `{"ok":false,"error":{"code","message"}}`.

use std::fmt;

/// Why the engine could not produce a result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EngineError {
    /// The request envelope is not valid JSON, lacks `op` or names an unknown operation.
    InvalidRequest(String),
    /// A field has a shape the TypeScript engine would reject (it throws) or does not type.
    InvalidInput(String),
    /// A value the TypeScript engine cannot process (for example rounding a number ≥ 1e21).
    UnsupportedValue(String),
}

impl EngineError {
    /// Stable machine-readable code.
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidRequest(_) => "invalid_request",
            Self::InvalidInput(_) => "invalid_input",
            Self::UnsupportedValue(_) => "unsupported_value",
        }
    }

    /// Human-readable detail.
    #[must_use]
    pub fn message(&self) -> &str {
        match self {
            Self::InvalidRequest(m) | Self::InvalidInput(m) | Self::UnsupportedValue(m) => m,
        }
    }

    pub(crate) fn input(message: impl Into<String>) -> Self {
        Self::InvalidInput(message.into())
    }
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code(), self.message())
    }
}

impl std::error::Error for EngineError {}
