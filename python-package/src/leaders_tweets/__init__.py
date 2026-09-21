"""Executive Social Media Database -- Python access layer.

Tweets and engagement metrics for 62 heads of government and state, 2009-2023.
Tables are downloaded from the project's API and cached locally; a free API key
is required. See https://github.com/juangomezcruces/Executive-Social-Media-Database.
"""

from .core import (
    MissingKeyError,
    api_key,
    cache_dir,
    clear_cache,
    data_version,
    get_sentiment,
    get_tweets,
    load_leaders,
    set_api_key,
)

__version__ = "2.0.0"

__all__ = [
    "load_leaders",
    "get_tweets",
    "get_sentiment",
    "data_version",
    "cache_dir",
    "clear_cache",
    "api_key",
    "set_api_key",
    "MissingKeyError",
    "__version__",
]
