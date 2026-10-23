class StocksController < ApplicationController
  # Tickers like AAPL, BRK-B, ^GSPC, BTC-USD, EURUSD=X, 7203.T
  SYMBOL_FORMAT = /\A[A-Z0-9.\-^=]{1,20}\z/

  def index
  end

  # GET /stocks/search?q=apple
  def search
    query = params[:q].to_s.strip
    return render(json: []) if query.empty? || query.length > 50

    render json: YahooFinance.search(query)
  rescue YahooFinance::Error => e
    render json: { error: e.message }, status: :bad_gateway
  end

  # GET /stocks/chart?symbol=AAPL&range=1m
  def chart
    symbol = params[:symbol].to_s.strip.upcase
    range  = params[:range].to_s

    unless symbol.match?(SYMBOL_FORMAT) && YahooFinance::RANGES.key?(range)
      return render(json: { error: "Invalid symbol or range" }, status: :bad_request)
    end

    expires_in 1.minute, public: true
    render json: YahooFinance.chart(symbol, range)
  rescue YahooFinance::Error => e
    render json: { error: e.message }, status: :bad_gateway
  end
end
