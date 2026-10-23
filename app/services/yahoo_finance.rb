require "net/http"
require "json"

# Thin client for Yahoo Finance's public (unofficial) endpoints.
# Everything Yahoo-specific lives here; the rest of the app sees plain hashes.
class YahooFinance
  class Error < StandardError; end


  BASE       = "https://query2.finance.yahoo.com".freeze
  COOKIE_URL = "https://fc.yahoo.com".freeze
  USER_AGENT = "Mozilla/5.0".freeze
  
  # UI range => Yahoo request. "1w" has no native Yahoo range, so it uses explicit dates.
  RANGES = {
    "1d" => { range: "1d",  interval: "5m" },
    "5d" => { range: "5d",  interval: "15m" },
    "1w" => { days: 7,      interval: "30m" },
    "1m" => { range: "1mo", interval: "60m" },
    "6m" => { range: "6mo", interval: "1d" },
    "1y" => { range: "1y",  interval: "1d" },
    "5y" => { range: "5y",  interval: "1wk" }
  }.freeze

  DAILY_INTERVALS = %w[1d 1wk 1mo].freeze
  SEARCH_TYPES    = %w[EQUITY ETF INDEX MUTUALFUND CRYPTOCURRENCY].freeze
  SESSION_TTL     = 3600

  CACHE = {}
  LOCK  = Mutex.new

  class << self
    # [{ symbol:, name:, exchange:, type: }, ...]
    def search(query)
      cached("search:#{query.downcase}", 600) do
        data = get("/v1/finance/search", { q: query, quotesCount: 8, newsCount: 0, listsCount: 0 })
        Array(data["quotes"])
          .select { |q| q["symbol"] && SEARCH_TYPES.include?(q["quoteType"]) }
          .map do |q|
            {
              symbol:   q["symbol"],
              name:     q["shortname"] || q["longname"] || q["symbol"],
              exchange: q["exchDisp"] || q["exchange"],
              type:     q["quoteType"]
            }
          end
      end
    end

    # { symbol:, name:, currency:, exchange:, timezone:, intraday:, price:, previous_close:, candles: [...] }
    def chart(symbol, range)
      spec = RANGES.fetch(range)
      ttl  = DAILY_INTERVALS.include?(spec[:interval]) ? 900 : 60

      cached("chart:#{symbol}:#{range}", ttl) do
        params = { interval: spec[:interval], includePrePost: false, events: "div,splits" }
        if spec[:days]
          now = Time.now.to_i
          params.merge!(period1: now - spec[:days] * 86_400, period2: now)
        else
          params[:range] = spec[:range]
        end

        data   = get("/v8/finance/chart/#{ERB::Util.url_encode(symbol)}", params)
        result = data.dig("chart", "result", 0)
        error  = data.dig("chart", "error", "description")
        raise Error, (error || "No data for #{symbol}") unless result

        normalize(result, intraday: !DAILY_INTERVALS.include?(spec[:interval]))
      end
    end

    private

    def normalize(result, intraday:)
      meta   = result["meta"] || {}
      quote  = result.dig("indicators", "quote", 0) || {}
      offset = meta["gmtoffset"].to_i
      times  = Array(result["timestamp"])

      candles = times.each_with_index.filter_map do |ts, i|
        o, h, l, c = %w[open high low close].map { |k| quote.dig(k, i) }
        next if [o, h, l, c].any?(&:nil?)

        time = intraday ? ts + offset : Time.at(ts + offset).utc.strftime("%Y-%m-%d")
        { time: time, open: o.round(4), high: h.round(4), low: l.round(4), close: c.round(4),
          volume: quote.dig("volume", i).to_i }
      end
      candles.uniq! { |c| c[:time] }
      raise Error, "No price data for this range" if candles.empty?

      {
        symbol:         meta["symbol"],
        name:           meta["longName"] || meta["shortName"] || meta["symbol"],
        currency:       meta["currency"],
        exchange:       meta["fullExchangeName"] || meta["exchangeName"],
        timezone:       meta["exchangeTimezoneName"],
        intraday:       intraday,
        price:          meta["regularMarketPrice"],
        previous_close: meta["chartPreviousClose"] || meta["previousClose"],
        candles:        candles
      }
    end

    # One GET with the session crumb. On 401/403/429 the session is refreshed and the call retried once.
    def get(path, params, retried = false)
      crumb, cookie = session
      uri = URI("#{BASE}#{path}")
      uri.query = URI.encode_www_form(params.merge(crumb: crumb))

      res = http_get(uri, "Cookie" => cookie)
      if %w[401 403 429].include?(res.code) && !retried
        reset_session
        return get(path, params, true)
      end

      body = JSON.parse(res.body) rescue nil
      raise Error, "Data provider error (HTTP #{res.code})" unless body && (res.is_a?(Net::HTTPSuccess) || body["chart"])
      body
    rescue Net::OpenTimeout, Net::ReadTimeout, SocketError, SystemCallError, OpenSSL::SSL::SSLError
      raise Error, "Data provider is unavailable, try again"
    end

    # Yahoo requires a cookie from fc.yahoo.com and a crumb tied to it.
    def session
      LOCK.synchronize do
        return @session[0..1] if @session && @session[2] > Time.now
      end

      res    = http_get(URI(COOKIE_URL))
      cookie = Array(res.get_fields("set-cookie")).map { |c| c.split(";").first }.join("; ")
      crumb  = http_get(URI("#{BASE}/v1/test/getcrumb"), "Cookie" => cookie).body.to_s.strip
      raise Error, "Could not open a Yahoo session" if crumb.empty? || crumb.include?("<")

      LOCK.synchronize { @session = [crumb, cookie, Time.now + SESSION_TTL] }
      [crumb, cookie]
    end

    def reset_session
      LOCK.synchronize { @session = nil }
    end

    def http_get(uri, headers = {})
      Net::HTTP.start(uri.host, uri.port, use_ssl: true, open_timeout: 5, read_timeout: 10) do |http|
        req = Net::HTTP::Get.new(uri)
        req["User-Agent"] = USER_AGENT
        req["Accept"] = "application/json,text/plain,*/*"
        headers.each { |k, v| req[k] = v }
        http.request(req)
      end
    end

    # Small in-process cache so repeated clicks don't hit Yahoo every time.
    def cached(key, ttl)
      LOCK.synchronize do
        entry = CACHE[key]
        return entry[1] if entry && entry[0] > Time.now
      end

      value = yield

      LOCK.synchronize do
        CACHE.shift while CACHE.size >= 500
        CACHE[key] = [Time.now + ttl, value]
      end
      value
    end
  end
end
