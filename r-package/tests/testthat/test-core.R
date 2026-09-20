# Every test runs against fixture tables written into a temporary cache.
# `.download` is stubbed to fail loudly, so an unexpected network call shows up
# as a test failure rather than a slow, flaky pass.

fixture_cache <- function() {
  path <- file.path(tempdir(), paste0("lt-", as.integer(runif(1, 1e6, 9e6))))
  version <- "v9.9.9"
  dir.create(file.path(path, version), recursive = TRUE, showWarnings = FALSE)

  leaders <- tibble::tibble(
    leader_id = c("modi", "trudeau", "may"),
    name = c("Narendra Modi", "Justin Trudeau", "Theresa May"),
    handle = c("narendramodi", "JustinTrudeau", "theresa_may"),
    country = c("India", "Canada", "United Kingdom"),
    country_iso3 = c("IND", "CAN", "GBR"),
    office = "Prime Minister",
    n_tweets = c(3L, 1L, 0L),
    first_tweet = as.POSIXct("2022-01-01", tz = "UTC"),
    last_tweet = as.POSIXct("2023-01-02", tz = "UTC"),
    total_retweets = c(1, 1, 0), total_replies = c(1, 1, 0),
    total_likes = c(1, 1, 0), total_quotes = c(1, 1, 0),
    mean_engagement = c(20, 40, 0),
    source_id_reliable = c(FALSE, TRUE, FALSE),
    has_sentiment = c(TRUE, TRUE, FALSE),
    source_files = "x.csv"
  )
  tweets <- tibble::tibble(
    tweet_uid = c("a1", "a2", "a3", "b1"),
    leader_id = c("modi", "modi", "modi", "trudeau"),
    country = c("India", "India", "India", "Canada"),
    created_at = as.POSIXct(
      c("2022-03-01 10:00:00", "2022-06-15 10:00:00",
        "2023-01-02 10:00:00", "2022-06-15 12:00:00"), tz = "UTC"),
    text = c("one", "two", "three", "four"),
    engagement = c(10L, 20L, 30L, 40L)
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
      leaders   = list(parquet = "https://example.invalid/leaders.parquet",
                       csv = "https://example.invalid/leaders.csv"),
      tweets    = list(parquet = "https://example.invalid/tweets.parquet",
                       csv = "https://example.invalid/tweets.csv"),
      sentiment = list(parquet = "https://example.invalid/sentiment.parquet",
                       csv = "https://example.invalid/sentiment.csv")
    )
  )
  writeLines(jsonlite::toJSON(manifest, auto_unbox = TRUE),
             file.path(path, "manifest.json"))
  path
}

with_fixtures <- function(code, mock_download = TRUE) {
  path <- fixture_cache()
  withr::local_envvar(LEADERS_TWEETS_CACHE = path)
  rm(list = ls(leaderstweets:::.memo), envir = leaderstweets:::.memo)
  if (mock_download) {
    # Any fetch here means the cache lookup failed; surface it rather than
    # letting a test quietly pass off the network.
    testthat::local_mocked_bindings(
      .download = function(url, dest) stop("unexpected network fetch: ", url)
    )
  }
  on.exit(rm(list = ls(leaderstweets:::.memo), envir = leaderstweets:::.memo),
          add = TRUE)
  force(code)
}

test_that("data_version reads the manifest", {
  with_fixtures(expect_equal(data_version(), "v9.9.9"))
})

test_that("load_leaders returns every leader as a tibble", {
  with_fixtures({
    leaders <- load_leaders()
    expect_s3_class(leaders, "tbl_df")
    expect_equal(nrow(leaders), 3L)
    expect_setequal(leaders$leader_id, c("modi", "trudeau", "may"))
  })
})

test_that("get_tweets with no arguments returns everything", {
  with_fixtures(expect_equal(nrow(get_tweets()), 4L))
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
