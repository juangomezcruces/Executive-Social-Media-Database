"""Executive Social Media Database -- Python access layer.

Tweets and engagement metrics for 38 heads of government and state, 2010-2023.
Data is fetched from the repository's latest GitHub release and cached locally;
see https://github.com/juangomezcruces/Executive-Social-Media-Database.
"""

from .core import (
    cache_dir,
    clear_cache,
    data_version,
    get_sentiment,
    get_tweets,
    load_leaders,
)

__version__ = "1.0.0"

__all__ = [
    "load_leaders",
    "get_tweets",
    "get_sentiment",
    "data_version",
    "cache_dir",
    "clear_cache",
    "__version__",
]
