# Schema

The Executive Social Media Database ships three tables. `leaders` is the
dimension table; `tweets` and `sentiment` both join back to it on `leader_id`,
and `sentiment` joins to `tweets` on `tweet_uid`.

Every table is published as Parquet (canonical, typed) and CSV (readable,
diffable) on each tagged release.

## A note on tweet ids

The raw collection files carry an `id` column, but it is **not** a usable
primary key. In 12 of the 52 source files the same value is attached to several
distinct tweets -- `tweetsModi.csv` is the extreme case, with 3,921 distinct ids
spread across 56,941 distinct tweets. The cause appears to be a collector that
wrote something other than the tweet id (a conversation id or a paging cursor)
for those runs.

Rows are therefore keyed on **`tweet_uid`**, a BLAKE2b-64 digest of
`leader_id | created_at | text`. The raw value is preserved as
`source_tweet_id`, and `source_id_reliable` tells you whether it can be trusted
for that leader -- check it before using ids to rehydrate against the X API.


*Generated from `data/schema.json` for release `v1.1.0`.*

## `leaders`

60 rows.

| column | type | description |
| --- | --- | --- |
| `leader_id` | `str` | Stable snake_case key. Join key for every other table. |
| `name` | `str` | Full name of the executive, rendered in English. |
| `handle` | `str` | X/Twitter account the tweets were collected from, without the @. |
| `country` | `str` | Country name in English. |
| `country_iso3` | `str` | ISO 3166-1 alpha-3 country code. |
| `office` | `str` | Title held during the collection window. |
| `n_tweets` | `int64` | Number of distinct tweets for this leader in the tweets table. |
| `first_tweet` | `datetime64[ns, UTC]` | Timestamp of the earliest tweet collected (UTC). |
| `last_tweet` | `datetime64[ns, UTC]` | Timestamp of the latest tweet collected (UTC). |
| `total_retweets` | `int64` | Sum of retweet_count over all of this leader's tweets. |
| `total_replies` | `int64` | Sum of reply_count over all of this leader's tweets. |
| `total_likes` | `int64` | Sum of like_count over all of this leader's tweets. |
| `total_quotes` | `int64` | Sum of quote_count over all of this leader's tweets. |
| `mean_engagement` | `float64` | Mean of (retweets + replies + likes + quotes) per tweet. |
| `source_id_reliable` | `bool` | False when the raw collection file reused tweet ids across distinct tweets; see source_tweet_id. |
| `has_sentiment` | `bool` | True when this leader appears in the sentiment table. |
| `populist` | `boolean` | Populist classification carried in the Latin America source file; the dataset author's own research coding, not an external standard. Null for leaders outside that batch. |
| `source_files` | `str` | Semicolon-separated raw collection files this leader was built from. |

## `tweets`

440,004 rows.

| column | type | description |
| --- | --- | --- |
| `tweet_uid` | `string` | Primary key. BLAKE2b-64 digest of leader_id \| created_at \| text. |
| `leader_id` | `string` | Foreign key into leaders. |
| `country` | `string` | Denormalised from leaders for convenient filtering. |
| `country_iso3` | `string` | Denormalised from leaders. |
| `created_at` | `object` | Tweet timestamp, UTC. |
| `date` | `object` | Calendar date of created_at, UTC. Convenience column for daily aggregation. |
| `lang` | `string` | Language code assigned by X at collection time. |
| `text` | `string` | Tweet text as collected. |
| `retweet_count` | `int64` | Retweets at collection time. |
| `reply_count` | `int64` | Replies at collection time. |
| `like_count` | `int64` | Likes at collection time. |
| `quote_count` | `int64` | Quote tweets at collection time. |
| `engagement` | `int64` | retweet_count + reply_count + like_count + quote_count. |
| `possibly_sensitive` | `boolean` | X's possibly_sensitive flag; null where not returned. |
| `in_reply_to_user_id` | `string` | User id this tweet replies to; null for non-replies. |
| `tweet_type` | `string` | Tweet type as returned by the collector; frequently null. |
| `source_tweet_id` | `string` | Raw id from the collection file. NOT unique in 12 of 52 files. |
| `source_id_reliable` | `bool` | True when source_tweet_id is 1:1 with distinct tweets in this leader's source files. |
| `source_file` | `string` | Raw collection file this row came from. |

## `sentiment`

142,623 rows.

| column | type | description |
| --- | --- | --- |
| `tweet_uid` | `str` | Foreign key into tweets. |
| `leader_id` | `str` | Foreign key into leaders. |
| `sentiment` | `str` | Predicted label: POS, NEU or NEG. |
| `prob_neg` | `float32` | Model probability for the NEG class. |
| `prob_neu` | `float32` | Model probability for the NEU class. |
| `prob_pos` | `float32` | Model probability for the POS class. |
