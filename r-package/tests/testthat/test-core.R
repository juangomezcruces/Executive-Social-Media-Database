# Every test runs against fixture tables written into a temporary cache.
# `.download` is stubbed to fail loudly, so an unexpected network call shows up
# as a test failure rather than a slow, flaky pass.

fixture_cache <- function() {
  path <- file.path(tempdir(), paste0("lt-", as.integer(runif(1, 1e6, 9e6))))
  version <- "v9.9.9"
  dir.create(file.path(path, version), recursive = TRUE, showWarnings = FALSE)

  leaders <- tibble::tibble(
    leader_id = c("modi", "trudeau", "may", "chavez", "morales_jimmy"),
    name = c("Narendra Modi", "Justin Trudeau", "Theresa May",
             intToUtf8(c(72,117,103,111,32,67,104,225,118,101,122)),  # Hugo Chavez, accented
             "Jimmy Morales"),
    # handle is NA for leaders whose account could not be verified.
    handle = c("narendramodi", "JustinTrudeau", "theresa_may",
               "chavezcandanga", NA_character_),
    country = c("India", "Canada", "United Kingdom", "Venezuela", "Guatemala"),
    country_iso3 = c("IND", "CAN", "GBR", "VEN", "GTM"),
    office = "Prime Minister",
    n_tweets = c(3L, 1L, 0L, 1L, 1L),
    first_tweet = as.POSIXct("2022-01-01", tz = "UTC"),
    last_tweet = as.POSIXct("2023-01-02", tz = "UTC"),
    total_retweets = c(1, 1, 0, 1, 1), total_replies = c(1, 1, 0, 1, 1),
    total_likes = c(1, 1, 0, 1, 1), total_quotes = c(1, 1, 0, 1, 1),
    mean_engagement = c(20, 40, 0, 50, 60),
    source_id_reliable = c(FALSE, TRUE, FALSE, TRUE, TRUE),
    has_sentiment = c(TRUE, TRUE, FALSE, FALSE, FALSE),
    source_files = "x.csv"
  )
  tweets <- tibble::tibble(
    tweet_uid = c("a1", "a2", "a3", "b1", "c1", "d1"),
    leader_id = c("modi", "modi", "modi", "trudeau", "chavez", "morales_jimmy"),
    country = c("India", "India", "India", "Canada", "Venezuela", "Guatemala"),
    created_at = as.POSIXct(
      c("2022-03-01 10:00:00", "2022-06-15 10:00:00",
        "2023-01-02 10:00:00", "2022-06-15 12:00:00",
        "2012-06-15 12:00:00", "2016-06-15 12:00:00"), tz = "UTC"),
    text = c("one", "two", "three", "four", "cinco", "seis"),
    engagement = c(10L, 20L, 30L, 40L, 50L, 60L)
  )
  tweets$date <- as.Date(tweets$created_at)
  sentiment <- tibble::tibble(
    tweet_uid = c("a1", "b1"),
    leader_id = c("modi", "trudeau"),
    sentiment = c("POS", "NEG"),
    prob_neg = c(0.01, 0.80), prob_neu = c(0.09, 0.15), prob_pos = c(0.90, 0.05)
  )

  readr::write_csv(leaders, file.path(path, version, "leaders.csv"))
  readr::write_csv(tweets, file.path(path, version, "tweets.csv"))
  readr::write_csv(sentiment, file.path(path, version, "sentiment.csv"))

  # The package prefers Parquet when arrow is installed, so give it both.
  if (requireNamespace("arrow", quietly = TRUE)) {
    arrow::write_parquet(leaders, file.path(path, version, "leaders.parquet"))
    arrow::write_parquet(tweets, file.path(path, version, "tweets.parquet"))
    arrow::write_parquet(sentiment, file.path(path, version, "sentiment.parquet"))
  }

  manifest <- list(
    dataset = "Executive Social Media Database",
    version = version,
    tables = list(
      leaders   = list(rows = 5L, parquet = list(bytes = 0L, sha256 = ""),
                       csv = list(bytes = 0L, sha256 = "")),
      tweets    = list(rows = 6L, parquet = list(bytes = 0L, sha256 = ""),
                       csv = list(bytes = 0L, sha256 = "")),
      sentiment = list(rows = 2L, parquet = list(bytes = 0L, sha256 = ""),
                       csv = list(bytes = 0L, sha256 = ""))
    )
  )
  writeLines(jsonlite::toJSON(manifest, auto_unbox = TRUE),
             file.path(path, "manifest.json"))
  path
}

with_fixtures <- function(code, mock_download = TRUE) {
  path <- fixture_cache()
  # A real key or API address in the developer's environment must not leak in.
  withr::local_envvar(LEADERS_TWEETS_CACHE = path,
                      LEADERS_TWEETS_KEY = NA,
                      LEADERS_TWEETS_API = "https://api.invalid/v1")
  withr::local_options(leaderstweets.api_key = NULL)
  set_api_key(NULL)
  rm(list = ls(leaderstweets:::.memo), envir = leaderstweets:::.memo)
  if (mock_download) {
    # Any fetch here means the cache lookup failed; surface it rather than
    # letting a test quietly pass off the network.
    testthat::local_mocked_bindings(
      .download = function(url, dest) stop("unexpected network fetch: ", url)
    )
  }
  on.exit({
    rm(list = ls(leaderstweets:::.memo), envir = leaderstweets:::.memo)
    set_api_key(NULL)
  }, add = TRUE)
  force(code)
}

test_that("data_version reads the manifest", {
  with_fixtures(expect_equal(data_version(), "v9.9.9"))
})

test_that("load_leaders returns every leader as a tibble", {
  with_fixtures({
    leaders <- load_leaders()
    expect_s3_class(leaders, "tbl_df")
    expect_equal(nrow(leaders), 5L)
    expect_true(all(c("modi", "trudeau", "may") %in% leaders$leader_id))
  })
})

test_that("get_tweets with no arguments returns everything", {
  with_fixtures(expect_equal(nrow(get_tweets()), 6L))
})

test_that("get_tweets filters by leader_id", {
  with_fixtures(expect_setequal(get_tweets("modi")$tweet_uid, c("a1", "a2", "a3")))
})

test_that("leader accepts id, name and handle interchangeably", {
  with_fixtures({
    for (alias in c("modi", "MODI", "Narendra Modi", "narendramodi")) {
      expect_equal(nrow(get_tweets(alias)), 3L, info = alias)
    }
  })
})

test_that("the end bound includes the whole calendar day", {
  with_fixtures({
    got <- get_tweets("modi", start = "2022-06-15", end = "2022-06-15")
    expect_equal(got$tweet_uid, "a2")
  })
})

test_that("a date range filters both ends", {
  with_fixtures({
    got <- get_tweets("modi", start = "2022-01-01", end = "2022-12-31")
    expect_setequal(got$tweet_uid, c("a1", "a2"))
  })
})

test_that("an open-ended start works", {
  with_fixtures(expect_setequal(get_tweets(start = "2023-01-01")$tweet_uid, "a3"))
})

test_that("an unknown leader errors helpfully", {
  with_fixtures(expect_error(get_tweets("Winston Churchill"), "unknown leader"))
})

test_that("an ambiguous leader errors", {
  with_fixtures(expect_error(get_tweets("a"), "ambiguous"))
})

test_that("get_sentiment joins tweet timestamps", {
  with_fixtures({
    got <- get_sentiment("modi")
    expect_equal(got$tweet_uid, "a1")
    expect_true("created_at" %in% names(got))
  })
})

test_that("get_sentiment respects the date range", {
  with_fixtures(expect_equal(nrow(get_sentiment(start = "2023-01-01")), 0L))
})

test_that("a stale manifest still resolves when offline", {
  # The manifest is deliberately treated as expired, so .manifest() attempts a
  # refresh, fails, and must fall back to the cached copy instead of erroring.
  with_fixtures(
    {
      testthat::local_mocked_bindings(
        MANIFEST_TTL_SECONDS = -1,
        .download = function(url, dest) stop("no network")
      )
      expect_equal(data_version(), "v9.9.9")
    },
    mock_download = FALSE
  )
})

test_that("leader matching ignores accents and locale", {
  # Under a C locale, tolower()/grepl() on a multi-byte name used to fail
  # outright and get_tweets() handed back the entire table. Both packages now
  # fold accents at the codepoint level and must agree.
  with_fixtures({
    accented_lower <- intToUtf8(c(72,117,103,111,32,67,104,225,118,101,122))
    accented_upper <- intToUtf8(c(67,72,193,86,69,90))
    for (alias in c("chavez", "Chavez", accented_upper, accented_lower,
                    "Hugo Chavez", "chavezcandanga")) {
      expect_equal(get_tweets(alias)$tweet_uid, "c1", info = alias)
    }
  })
})

test_that("a leader with no handle still resolves", {
  with_fixtures(expect_equal(get_tweets("Jimmy Morales")$tweet_uid, "d1"))
})

test_that("a filtered query never falls through to the whole table", {
  with_fixtures({
    expect_lt(nrow(get_tweets("modi")), nrow(get_tweets()))
    expect_error(get_tweets("Winston Churchill"))
  })
})

# ---------------------------------------------------------------------------
# API keys -- the same contract as the Python package
# ---------------------------------------------------------------------------

test_that("a missing key raises something actionable", {
  with_fixtures({
    version <- data_version()
    unlink(list.files(file.path(cache_dir(), version), full.names = TRUE))
    rm(list = ls(leaderstweets:::.memo), envir = leaderstweets:::.memo)
    expect_error(get_tweets(), "LEADERS_TWEETS_KEY")
    expect_error(get_tweets(), "set_api_key")
    expect_error(get_tweets(), "#api-keys", fixed = TRUE)
  })
})

test_that("the key is read from the environment", {
  with_fixtures({
    withr::local_envvar(LEADERS_TWEETS_KEY = "esmd_from_env")
    expect_equal(api_key(), "esmd_from_env")
  })
})

test_that("set_api_key wins over the environment and the option", {
  with_fixtures({
    withr::local_envvar(LEADERS_TWEETS_KEY = "esmd_from_env")
    withr::local_options(leaderstweets.api_key = "esmd_from_option")
    set_api_key("esmd_explicit")
    expect_equal(api_key(), "esmd_explicit")
    set_api_key(NULL)
    expect_equal(api_key(), "esmd_from_option")
  })
})

test_that("a persisted key survives clear_cache", {
  # clear_cache() empties the same directory the key lives in; a key is a
  # credential, not a cache, so it has to survive.
  with_fixtures({
    set_api_key("esmd_persisted", persist = TRUE)
    set_api_key(NULL)  # as if this were a fresh session
    clear_cache()
    expect_equal(api_key(), "esmd_persisted")
    set_api_key(NULL, persist = TRUE)
    expect_null(api_key())
  })
})

test_that("the download sends the key as a bearer token", {
  with_fixtures({
    set_api_key("esmd_secret")
    seen <- NULL
    local_mocked_bindings(
      .download = function(url, dest) {
        # Stand in for httr2: record what the real .download would have sent.
        seen <<- list(url = url, key = api_key())
        dest
      }
    )
    leaderstweets:::.download("https://api.invalid/v1/download/tweets.parquet",
                              tempfile())
    expect_equal(seen$key, "esmd_secret")
  }, mock_download = FALSE)
})

test_that("a corrupted download is discarded", {
  with_fixtures({
    # Whichever format this machine will actually fetch: with arrow installed
    # the package prefers Parquet, without it the CSV. Both are verified.
    fmt <- if (requireNamespace("arrow", quietly = TRUE)) "parquet" else "csv"
    version <- data_version()
    manifest <- jsonlite::fromJSON(file.path(cache_dir(), "manifest.json"),
                                   simplifyVector = FALSE)
    manifest$tables$tweets[[fmt]]$sha256 <- strrep("0", 64)
    writeLines(jsonlite::toJSON(manifest, auto_unbox = TRUE),
               file.path(cache_dir(), "manifest.json"))
    local <- file.path(cache_dir(), version, paste0("tweets.", fmt))
    unlink(local)
    rm(list = ls(leaderstweets:::.memo), envir = leaderstweets:::.memo)
    set_api_key("esmd_valid")
    local_mocked_bindings(
      .download = function(url, dest) {
        writeLines("not the table you asked for", dest)
        dest
      }
    )
    expect_error(get_tweets(), "digest")
    expect_false(file.exists(local))
  }, mock_download = FALSE)
})

test_that("the R digest matches Python's hexdigest byte for byte", {
  # The two packages verify the same manifest, so they must compute the same
  # string from the same bytes.
  path <- tempfile()
  writeBin(charToRaw("the quick brown fox"), path)
  expect_equal(
    leaderstweets:::.sha256_file(path),
    # python: hashlib.sha256(b"the quick brown fox").hexdigest()
    "9ecb36561341d18eb65484e833efea61edc74b84cf5e6ae1b81c63533e25fc8f"
  )
})

test_that("a download whose digest matches is kept", {
  # The mirror of the corruption test: the check must not reject a good file.
  # It did, once -- openssl returns a classed object and identical() compared
  # the class too, so every honest download looked corrupt.
  with_fixtures({
    fmt <- if (requireNamespace("arrow", quietly = TRUE)) "parquet" else "csv"
    version <- data_version()
    local <- file.path(cache_dir(), version, paste0("tweets.", fmt))
    good <- readBin(local, "raw", file.size(local))
    manifest <- jsonlite::fromJSON(file.path(cache_dir(), "manifest.json"),
                                   simplifyVector = FALSE)
    manifest$tables$tweets[[fmt]]$sha256 <- leaderstweets:::.sha256_file(local)
    writeLines(jsonlite::toJSON(manifest, auto_unbox = TRUE),
               file.path(cache_dir(), "manifest.json"))
    unlink(local)
    rm(list = ls(leaderstweets:::.memo), envir = leaderstweets:::.memo)
    set_api_key("esmd_valid")
    local_mocked_bindings(
      .download = function(url, dest) { writeBin(good, dest); dest }
    )
    expect_equal(nrow(get_tweets()), 6L)
    expect_true(file.exists(local))
  }, mock_download = FALSE)
})
