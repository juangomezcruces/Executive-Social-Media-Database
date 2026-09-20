#' @keywords internal
"_PACKAGE"

REPO <- "juangomezcruces/Executive-Social-Media-Database"
MANIFEST_URL <- paste0("https://github.com/", REPO,
                       "/releases/latest/download/manifest.json")

#' Seconds a cached manifest is trusted before re-checking for a new release.
#' @noRd
MANIFEST_TTL_SECONDS <- 24 * 60 * 60

# In-session memo so repeated calls do not re-read from disk.
.memo <- new.env(parent = emptyenv())

# ---------------------------------------------------------------------------
# cache plumbing
# ---------------------------------------------------------------------------

#' Location of the local data cache
#'
#' Returns the directory in which downloaded tables are stored. Override it by
#' setting the `LEADERS_TWEETS_CACHE` environment variable.
#'
#' @return A length-one character vector: the cache directory path.
#' @examples
#' cache_dir()
#' @export
cache_dir <- function() {
  override <- Sys.getenv("LEADERS_TWEETS_CACHE", unset = "")
  path <- if (nzchar(override)) override else
    rappdirs::user_cache_dir("leaders_tweets", "esmd")
  dir.create(path, recursive = TRUE, showWarnings = FALSE)
  path
}

#' Empty the local data cache
#'
#' Deletes every cached manifest and table. The next call to [load_leaders()],
#' [get_tweets()] or [get_sentiment()] downloads them again.
#'
#' @return `NULL`, invisibly.
#' @examples
#' \dontrun{
#' clear_cache()
#' }
#' @export
clear_cache <- function() {
  rm(list = ls(.memo), envir = .memo)
  unlink(cache_dir(), recursive = TRUE)
  invisible(NULL)
}

#' Download a URL to a local path
#' @noRd
.download <- function(url, dest) {
  dir.create(dirname(dest), recursive = TRUE, showWarnings = FALSE)
  tmp <- paste0(dest, ".part")
  httr2::req_perform(
    httr2::req_timeout(httr2::request(url), 300),
    path = tmp
  )
  file.rename(tmp, dest)
  dest
}

#' Read the release manifest, refreshing it when stale
#' @noRd
.manifest <- function(refresh = FALSE) {
  path <- file.path(cache_dir(), "manifest.json")
  age <- if (file.exists(path)) {
    as.numeric(difftime(Sys.time(), file.info(path)$mtime, units = "secs"))
  } else Inf
  if (refresh || age > MANIFEST_TTL_SECONDS) {
    ok <- tryCatch({ .download(MANIFEST_URL, path); TRUE },
                   error = function(e) FALSE)
    # Offline with a cached copy: keep using it rather than failing.
    if (!ok && !file.exists(path)) {
      stop("could not download the dataset manifest from ", MANIFEST_URL,
           " and no cached copy is available.", call. = FALSE)
    }
  }
  jsonlite::fromJSON(path, simplifyVector = TRUE)
}

#' Fetch and parse one table, memoised for the session
#' @noRd
.table <- function(name) {
  if (!is.null(.memo[[name]])) return(.memo[[name]])

  manifest <- .manifest()
  version <- manifest$version
  entry <- manifest$tables[[name]]
  has_arrow <- requireNamespace("arrow", quietly = TRUE)

  # Parquet is canonical and much smaller, but arrow is a heavy dependency, so
  # fall back to the CSV asset when it is not installed.
  fmt <- if (has_arrow) "parquet" else "csv"
  local <- file.path(cache_dir(), version, paste0(name, ".", fmt))
  if (!file.exists(local)) .download(entry[[fmt]], local)

  out <- if (has_arrow) {
    tibble::as_tibble(arrow::read_parquet(local))
  } else {
    header <- names(readr::read_csv(local, n_max = 0, show_col_types = FALSE,
                                    progress = FALSE))
    readr::read_csv(local, show_col_types = FALSE, progress = FALSE,
                    col_types = .col_types(name, header))
  }
  assign(name, out, envir = .memo)
  out
}

#' Column types for the CSV fallback, so both paths agree
#'
#' Defaults to character, which matters: `source_tweet_id` holds 19-digit
#' snowflake ids that readr would otherwise guess as doubles and silently round.
#' Only the columns actually present in the file are named, so a narrower CSV
#' (a fixture, or a future release that drops a column) still reads.
#' @noRd
.col_types <- function(name, present) {
  spec <- switch(name,
    tweets = list(
      created_at = readr::col_datetime(),
      date = readr::col_date(),
      retweet_count = readr::col_integer(),
      reply_count = readr::col_integer(),
      like_count = readr::col_integer(),
      quote_count = readr::col_integer(),
      engagement = readr::col_integer(),
      possibly_sensitive = readr::col_logical(),
      source_id_reliable = readr::col_logical()
    ),
    sentiment = list(
      prob_neg = readr::col_double(),
      prob_neu = readr::col_double(),
      prob_pos = readr::col_double()
    ),
    leaders = list(
      first_tweet = readr::col_datetime(),
      last_tweet = readr::col_datetime(),
      n_tweets = readr::col_integer(),
      total_retweets = readr::col_double(),
      total_replies = readr::col_double(),
      total_likes = readr::col_double(),
      total_quotes = readr::col_double(),
      mean_engagement = readr::col_double(),
      source_id_reliable = readr::col_logical(),
      has_sentiment = readr::col_logical()
    ),
    list()
  )
  spec <- spec[names(spec) %in% present]
  do.call(readr::cols, c(spec, list(.default = readr::col_character())))
}

# ---------------------------------------------------------------------------
# public API -- mirrors the Python package function for function
# ---------------------------------------------------------------------------

#' Which data release is in use
#'
#' Reports the GitHub release tag that the cached tables came from. The tag is
#' read from the manifest attached to the repository's latest release, so it
#' changes on its own when new data is published.
#'
#' @return A length-one character vector, for example `"v1.0.0"`.
#' @examples
#' \dontrun{
#' data_version()
#' }
#' @export
data_version <- function() {
  .manifest()$version
}

#' Load the leader dimension table
#'
#' One row per executive in the dataset, with the identifiers, country, office
#' and per-leader totals. `leader_id` is the key that [get_tweets()] and
#' [get_sentiment()] join on.
#'
#' @return A tibble with one row per leader.
#' @examples
#' \dontrun{
#' load_leaders()
#' }
#' @seealso [get_tweets()], [get_sentiment()]
#' @export
load_leaders <- function() {
  .table("leaders")
}

#' Resolve a leader_id, name or handle to a leader_id
#' @noRd
.resolve_leader <- function(leader) {
  leaders <- .table("leaders")
  needle <- tolower(trimws(leader))

  for (column in c("leader_id", "handle", "name")) {
    hit <- leaders$leader_id[tolower(leaders[[column]]) == needle]
    if (length(hit) == 1L) return(hit)
  }

  partial <- leaders[grepl(needle, tolower(leaders$name), fixed = TRUE), ]
  if (nrow(partial) == 1L) return(partial$leader_id)
  if (nrow(partial) > 1L) {
    stop(sprintf("'%s' is ambiguous; it matches: %s", leader,
                 paste(sort(partial$name), collapse = ", ")), call. = FALSE)
  }

  stop(sprintf("unknown leader '%s'. Call load_leaders() to see the %d available leaders.",
               leader, nrow(leaders)), call. = FALSE)
}

#' Apply the shared leader and date filters
#' @noRd
.filter_rows <- function(data, leader, start, end) {
  if (!is.null(leader)) {
    data <- data[data$leader_id == .resolve_leader(leader), , drop = FALSE]
  }
  if (!is.null(start)) {
    from <- as.POSIXct(paste0(start, " 00:00:00"), tz = "UTC")
    data <- data[data$created_at >= from, , drop = FALSE]
  }
  if (!is.null(end)) {
    # `end` is inclusive of the whole calendar day.
    to <- as.POSIXct(paste0(end, " 00:00:00"), tz = "UTC") + 86400
    data <- data[data$created_at < to, , drop = FALSE]
  }
  tibble::as_tibble(data)
}

#' Get tweets, optionally filtered by leader and date range
#'
#' @param leader A `leader_id`, full name, X handle or unique surname,
#'   matched case-insensitively. `NULL` (the default) returns every leader.
#' @param start,end Inclusive `"YYYY-MM-DD"` bounds on `created_at`. `NULL`
#'   leaves that end of the range open.
#'
#' @return A tibble with one row per tweet, keyed on `tweet_uid`.
#' @examples
#' \dontrun{
#' get_tweets("Modi", start = "2022-01-01", end = "2022-12-31")
#' get_tweets("narendramodi")
#' }
#' @seealso [load_leaders()], [get_sentiment()]
#' @export
get_tweets <- function(leader = NULL, start = NULL, end = NULL) {
  .filter_rows(.table("tweets"), leader, start, end)
}

#' Get sentiment-classified tweets
#'
#' Covers the 11 leaders that were run through the sentiment classifier. The
#' sentiment table carries no timestamp of its own, so it is joined to the
#' tweets table on `tweet_uid` before the date filter is applied.
#'
#' @inheritParams get_tweets
#'
#' @return A tibble with one row per classified tweet, carrying the predicted
#'   label and the three class probabilities.
#' @examples
#' \dontrun{
#' get_sentiment("Trudeau")
#' }
#' @seealso [get_tweets()]
#' @export
get_sentiment <- function(leader = NULL, start = NULL, end = NULL) {
  sentiment <- .table("sentiment")
  tweets <- .table("tweets")[, c("tweet_uid", "created_at", "date", "text", "engagement")]
  merged <- merge(sentiment, tweets, by = "tweet_uid", sort = FALSE)
  .filter_rows(merged, leader, start, end)
}
