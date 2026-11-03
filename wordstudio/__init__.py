"""Alamza Word Studio: local, private, word-level transcription powered by WhisperX."""

__version__ = "1.0.0"
APP_NAME = "Alamza Word Studio"
APP_ID = "alamza-word-studio"

# Importing config points all model/data caches into the app folder (portable mode).
from . import config as _config  # noqa: E402,F401
