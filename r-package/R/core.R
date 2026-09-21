#' @keywords internal
"_PACKAGE"

REPO <- "juangomezcruces/Executive-Social-Media-Database"

#' The deployed Worker. Override with the `LEADERS_TWEETS_API` environment
#' variable. `scripts/set_api_url.py` rewrites this line, the Python package
#' and the web app together, so the three clients cannot drift apart.
#' @noRd
API_BASE <- "https://esmd-api.REPLACE-ME.workers.dev/v1"

#' Seconds a cached manifest is trusted before re-checking for a new release.
#' @noRd
MANIFEST_TTL_SECONDS <- 24 * 60 * 60

# In-session memo so repeated calls do not re-read from disk.
.memo <- new.env(parent = emptyenv())

# The key set by set_api_key() for this session.
.session <- new.env(parent = emptyenv())

#' The API root, without a trailing slash
#' @noRd
.api_base <- function() {
  base <- Sys.getenv("LEADERS_TWEETS_API", unset = API_BASE)
  sub("/+$", "", base)
}

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
#' [get_tweets()] or [get_sentiment()] downloads them again. A key saved by
#' `set_api_key(persist = TRUE)` is left alone: it is a credential, not a
#' cache, and throwing it away here would be a surprising thing to do.
#'
#' @return `NULL`, invisibly.
#' @examples
#' \dontrun{
#' clear_cache()
#' }
#' @export
clear_cache <- function() {
  rm(list = ls(.memo), envir = .memo)
  keep <- .key_file()
  for (path in list.files(cache_dir(), full.names = TRUE, all.files = TRUE,
                          no.. = TRUE)) {
    if (!identical(normalizePath(path, mustWork = FALSE),
                   normalizePath(keep, mustWork = FALSE))) {
      unlink(path, recursive = TRUE)
    }
  }
  invisible(NULL)
}

# ---------------------------------------------------------------------------
# API keys
# ---------------------------------------------------------------------------

#' @noRd
.key_file <- function() file.path(cache_dir(), "api_key")

#' Message shown whenever the API refuses a request for lack of a key
#' @noRd
.key_help <- function(status) {
  paste0(
    "the API rejected this request (HTTP ", status, ").\n\n",
    "Full tables need an API key. They are free for research use -- ask at\n",
    "    https://github.com/", REPO, "#api-keys\n",
    "then either\n",
    "    Sys.setenv(LEADERS_TWEETS_KEY = \"esmd_...\")\n",
    "or, once per machine,\n",
    "    set_api_key(\"esmd_...\", persist = TRUE)\n",
    "If you already set one, it may have been revoked or mistyped."
  )
}

#' The API key in effect
#'
#' Looked up in order: the key set by [set_api_key()] in this session, the
#' `leaderstweets.api_key` option, the `LEADERS_TWEETS_KEY` environment
#' variable, then a key saved on this machine by
#' `set_api_key(persist = TRUE)`.
#'
#' @return A length-one character vector, or `NULL` when no key is set.
#' @examples
#' api_key()
#' @seealso [set_api_key()]
#' @export
api_key <- function() {
  if (!is.null(.session$key)) return(.session$key)
  from_option <- getOption("leaderstweets.api_key", default = NULL)
  if (!is.null(from_option) && nzchar(from_option)) return(trimws(from_option))
  from_env <- Sys.getenv("LEADERS_TWEETS_KEY", unset = "")
  if (nzchar(from_env)) return(trimws(from_env))
  path <- .key_file()
  if (file.exists(path)) {
    stored <- trimws(paste(readLines(path, warn = FALSE), collapse = ""))
    if (nzchar(stored)) return(stored)
  }
  NULL
}

#' Set the API key
#'
#' Sets the key for this session and, with `persist = TRUE`, saves it in the
#' cache directory readable only by the current user. Pass `NULL` to clear it.
#'
#' @param key The key, as issued, or `NULL` to clear.
#' @param persist Whether to save the key on this machine for future sessions.
#'
#' @return `NULL`, invisibly.
#' @examples
#' \dontrun{
#' set_api_key("esmd_...", persist = TRUE)
#' }
#' @seealso [api_key()]
#' @export
set_api_key <- function(key, persist = FALSE) {
  .session$key <- if (is.null(key) || !nzchar(key)) NULL else trimws(key)
  if (isTRUE(persist)) {
    path <- .key_file()
    if (is.null(.session$key)) {
      unlink(path)
    } else {
      writeLines(.session$key, path)
      Sys.chmod(path, mode = "0600")
    }
  }
  invisible(NULL)
}

#' Download a URL to a local path, sending the API key if there is one
#' @noRd
.download <- function(url, dest) {
  dir.create(dirname(dest), recursive = TRUE, showWarnings = FALSE)
  tmp <- paste0(dest, ".part")
  request <- httr2::req_timeout(httr2::request(url), 300)
  key <- api_key()
  if (!is.null(key)) {
    request <- httr2::req_headers(request, Authorization = paste("Bearer", key))
  }
  # Handle the 401 ourselves so the user gets instructions rather than a stack
  # trace about an HTTP status.
  response <- httr2::req_perform(httr2::req_error(request, is_error = function(r) FALSE),
                                 path = tmp)
  status <- httr2::resp_status(response)
  if (status %in% c(401L, 403L)) {
    unlink(tmp)
    stop(.key_help(status), call. = FALSE)
  }
  if (status >= 400L) {
    unlink(tmp)
    stop("the API returned HTTP ", status, " for ", url, call. = FALSE)
  }
  file.rename(tmp, dest)
  dest
}

#' SHA-256 of a file as a lowercase hex string, matching Python's hexdigest
#'
#' Streams through a connection rather than reading the file into memory: the
#' tweets table is over 50 MB.
#' @noRd
.sha256_file <- function(path) {
  con <- file(path, "rb")
  on.exit(close(con), add = TRUE)
  # paste0(), not as.character(): openssl returns a classed "hash" object and
  # as.character() keeps that class, which makes identical() against a plain
  # string from the manifest false for every file, corrupt or not.
  paste0(openssl::sha256(con))
}

#' Read the release manifest, refreshing it when stale
#' @noRd
.manifest <- function(refresh = FALSE) {
  path <- file.path(cache_dir(), "manifest.json")
  url <- paste0(.api_base(), "/manifest")
  age <- if (file.exists(path)) {
    as.numeric(difftime(Sys.time(), file.info(path)$mtime, units = "secs"))
  } else Inf
  if (refresh || age > MANIFEST_TTL_SECONDS) {
    ok <- tryCatch({ .download(url, path); TRUE },
                   error = function(e) FALSE)
    # Offline with a cached copy: keep using it rather than failing.
    if (!ok && !file.exists(path)) {
      stop("could not download the dataset manifest from ", url,
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
  if (!file.exists(local)) {
    if (is.null(api_key())) stop(.key_help(401L), call. = FALSE)
    .download(paste0(.api_base(), "/download/", name, ".", fmt), local)
    # The manifest names a digest per file, so a truncated download is caught
    # here rather than three lines into someone's analysis.
    expected <- entry[[fmt]][["sha256"]]
    if (!is.null(expected) && nzchar(expected)) {
      got <- .sha256_file(local)
      if (!identical(got, expected)) {
        unlink(local)
        stop(name, ".", fmt, " did not match the digest in the manifest; the ",
             "download was discarded. Try again.", call. = FALSE)
      }
    }
  }

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
      source_id_reliable = readr::col_logical(),
      is_reply = readr::col_logical(),
      is_deleted = readr::col_logical()
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
      has_sentiment = readr::col_logical(),
      populist = readr::col_logical()
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
#' Reports the release tag that the cached tables came from. The tag is read
#' from the manifest the API publishes, so it changes on its own when new data
#' is released. Reading the manifest needs no API key.
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

#' Accented Latin-1 letters and their ASCII equivalents, as codepoints
#'
#' Deliberately integers rather than "\\u00e1" = "a" string literals: under a C
#' locale R cannot represent those escapes natively and renders them as the
#' literal text "<c3><a1>", which silently corrupts the lookup table. Integer
#' codepoints mean the same thing in every locale.
#' @noRd
.ACCENT_FROM <- c(224:229, 231L, 232:235, 236:239, 241L, 242:246, 249:252, 253L, 255L)
#' @noRd
.ACCENT_TO <- c(rep(97L, 6), 99L, rep(101L, 4), rep(105L, 4), 110L,
                rep(111L, 5), rep(117L, 4), 121L, 121L)

#' Lowercase and strip accents, independently of locale
#'
#' Done at the codepoint level on purpose. Under a C locale neither `tolower()`
#' nor `iconv(..., "ASCII//TRANSLIT")` touches multi-byte characters, and
#' `grepl()` then fails outright with "regular expression is invalid UTF-8" --
#' so matching a name like "Hugo Chavez" would break depending on the machine's
#' locale. This makes `"chavez"`, `"Chavez"` and `"Chávez"` equivalent
#' everywhere, matching the Python package.
#' @noRd
.fold <- function(x) {
  x <- enc2utf8(as.character(x))
  out <- vapply(x, function(s) {
    if (is.na(s)) return(NA_character_)
    cp <- tryCatch(utf8ToInt(s), error = function(e) NA_integer_)
    if (length(cp) == 0L || anyNA(cp)) return(trimws(s))
    ascii_upper <- cp >= 65L & cp <= 90L
    cp[ascii_upper] <- cp[ascii_upper] + 32L
    latin_upper <- cp >= 192L & cp <= 222L & cp != 215L  # 215 is the times sign
    cp[latin_upper] <- cp[latin_upper] + 32L
    hit <- match(cp, .ACCENT_FROM)
    cp[!is.na(hit)] <- .ACCENT_TO[hit[!is.na(hit)]]
    intToUtf8(cp)
  }, character(1), USE.NAMES = FALSE)
  trimws(out)
}

#' Resolve a leader_id, name or handle to a leader_id
#' @noRd
.resolve_leader <- function(leader) {
  leaders <- .table("leaders")
  needle <- .fold(leader)

  for (column in c("leader_id", "handle", "name")) {
    hit <- leaders$leader_id[!is.na(leaders[[column]]) &
                               .fold(leaders[[column]]) == needle]
    if (length(hit) == 1L) return(hit)
  }

  partial <- leaders[grepl(needle, .fold(leaders$name), fixed = TRUE), ]
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
    resolved <- .resolve_leader(leader)
    # A resolver that somehow yields nothing must not silently fall through to
    # "no filter" and hand back the whole table.
    if (length(resolved) != 1L || is.na(resolved)) {
      stop(sprintf("could not resolve leader '%s'", leader), call. = FALSE)
    }
    data <- data[!is.na(data$leader_id) & data$leader_id == resolved, , drop = FALSE]
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
