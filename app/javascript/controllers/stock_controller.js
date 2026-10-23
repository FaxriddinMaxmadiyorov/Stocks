import { Controller } from "@hotwired/stimulus"
import { createChart, CandlestickSeries, LineSeries, AreaSeries, HistogramSeries } from "lightweight-charts"

const RANGES = ["1d", "5d", "1w", "1m", "6m", "1y", "5y"]
const TYPES = ["candles", "line", "area"]
const RANGE_LABELS = { "1d": "today", "5d": "past 5 days", "1w": "past week", "1m": "past month",
                       "6m": "past 6 months", "1y": "past year", "5y": "past 5 years" }
const LIVE_RANGES = ["1d", "5d"]
const REFRESH_MS = 60_000

export default class extends Controller {
  static targets = ["symbol", "name", "price", "change", "chart", "legend", "overlay", "stats", "updated",
                    "rangeButton", "typeButton", "volumeButton"]
  static values = { chartUrl: String }

  connect() {
    const p = new URLSearchParams(location.search)
    this.symbol = (p.get("symbol") || "AAPL").toUpperCase()
    this.range = RANGES.includes(p.get("range")) ? p.get("range") : "1m"
    this.type = TYPES.includes(p.get("type")) ? p.get("type") : "candles"
    this.showVolume = p.get("volume") !== "0"
    this.quote = null
    this.candles = null

    this.chart = createChart(this.chartTarget, {
      autoSize: true,
      handleScroll: { vertTouchDrag: false }, // vertical swipe scrolls the page, not the chart
      localization: { timeFormatter: (t) => this.formatTime(t) }
    })

    this.volumeSeries = this.chart.addSeries(HistogramSeries, {
      priceScaleId: "volume", priceFormat: { type: "volume" },
      lastValueVisible: false, priceLineVisible: false, visible: this.showVolume
    })
    this.chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } })
    this.chart.subscribeCrosshairMove((param) => this.updateLegend(param))

    this.buildMainSeries()
    this.applyTheme()

    this.media = matchMedia("(prefers-color-scheme: dark)")
    this.onTheme = () => this.applyTheme()
    this.media.addEventListener("change", this.onTheme)

    this.onVisible = () => { if (!document.hidden && this.isLive) this.load({ quiet: true }) }
    document.addEventListener("visibilitychange", this.onVisible)

    this.syncButtons()
    this.load()
  }

  disconnect() {
    clearTimeout(this.timer)
    this.request?.abort()
    this.media.removeEventListener("change", this.onTheme)
    document.removeEventListener("visibilitychange", this.onVisible)
    this.chart.remove()
  }

  // ---- actions -------------------------------------------------------------

  select(event) {
    this.symbol = event.detail.symbol
    this.load()
  }

  setRange(event) {
    this.range = event.currentTarget.dataset.range
    this.syncButtons()
    this.load()
  }

  setType(event) {
    this.type = event.currentTarget.dataset.type
    this.buildMainSeries()
    this.syncButtons()
    this.updateUrl()
  }

  toggleVolume() {
    this.showVolume = !this.showVolume
    this.volumeSeries.applyOptions({ visible: this.showVolume })
    this.applyMargins()
    this.syncButtons()
    this.updateLegend()
    this.updateUrl()
  }

  resetZoom() {
    this.chart.timeScale().fitContent()
  }

  // ---- loading -------------------------------------------------------------

  async load({ quiet = false } = {}) {
    clearTimeout(this.timer)
    this.request?.abort()
    const request = (this.request = new AbortController())
    if (!quiet) this.showOverlay()

    const url = `${this.chartUrlValue}?${new URLSearchParams({ symbol: this.symbol, range: this.range })}`
    try {
      const res = await fetch(url, { signal: request.signal, headers: { Accept: "application/json" } })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
      if (!data.candles?.length) throw new Error(`No data for ${this.symbol} in this range`)
      this.render(data, { keepView: quiet })
      this.hideOverlay()
    } catch (e) {
      if (e.name === "AbortError") return
      if (!quiet) this.showOverlay(e.message)
    } finally {
      if (this.request === request) this.scheduleRefresh()
    }
  }

  scheduleRefresh() {
    if (!this.isLive) return
    this.timer = setTimeout(() => { if (!document.hidden) this.load({ quiet: true }) }, REFRESH_MS)
  }

  get isLive() {
    return Boolean(this.quote?.intraday) && LIVE_RANGES.includes(this.range)
  }

  // ---- rendering -----------------------------------------------------------

  render(data, { keepView = false } = {}) {
    const view = keepView ? this.chart.timeScale().getVisibleLogicalRange() : null
    this.quote = data
    this.candles = data.candles

    this.chart.applyOptions({ timeScale: { timeVisible: data.intraday, secondsVisible: false } })
    this.setMainData()
    this.setVolumeData()

    if (view) this.chart.timeScale().setVisibleLogicalRange(view)
    else this.chart.timeScale().fitContent()

    this.renderHeader()
    this.renderStats()
    this.updateLegend()
    this.updateUrl()

    const time = new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    this.updatedTarget.textContent = [
      `Updated ${time}`,
      this.isLive ? "refreshes every minute" : null,
      data.timezone ? `times in ${data.timezone}` : null
    ].filter(Boolean).join(" · ")
  }

  buildMainSeries() {
    if (this.mainSeries) this.chart.removeSeries(this.mainSeries)
    const kind = { candles: CandlestickSeries, line: LineSeries, area: AreaSeries }[this.type]
    this.mainSeries = this.chart.addSeries(kind, { lineWidth: 2 })
    this.styleSeries()
    this.applyMargins()
    if (this.candles) {
      this.setMainData()
      this.updateLegend()
    }
  }

  setMainData() {
    const precision = this.precision()
    this.mainSeries.applyOptions({ priceFormat: { type: "price", precision, minMove: 10 ** -precision } })
    const points = this.type === "candles"
      ? this.candles.map(({ time, open, high, low, close }) => ({ time, open, high, low, close }))
      : this.candles.map(({ time, close }) => ({ time, value: close }))
    this.mainSeries.setData(points)
  }

  setVolumeData() {
    if (!this.candles) return
    const { up, down } = this.colors
    this.volumeSeries.setData(this.candles.map((k) => ({
      time: k.time,
      value: k.volume || 0,
      color: rgba(k.close >= k.open ? up : down, 0.45)
    })))
  }

  applyMargins() {
    this.chart.priceScale("right").applyOptions({
      scaleMargins: { top: 0.1, bottom: this.showVolume ? 0.25 : 0.05 }
    })
  }

  renderHeader() {
    const d = this.quote
    const c = this.candles
    const last = d.price ?? c.at(-1).close
    const base = this.range === "1d" ? (d.previous_close ?? c[0].open) : c[0].open
    const diff = last - base
    const pct = base ? (diff / base) * 100 : 0
    const sign = diff >= 0 ? "+" : ""

    this.symbolTarget.textContent = d.symbol
    this.nameTarget.textContent = [d.name, d.exchange].filter(Boolean).join(" · ")
    this.priceTarget.textContent = `${this.fmtPrice(last)} ${d.currency || ""}`.trim()
    this.changeTarget.textContent = `${sign}${this.fmtPrice(diff)} (${sign}${pct.toFixed(2)}%) ${RANGE_LABELS[this.range]}`
    this.changeTarget.className = `change ${diff >= 0 ? "up" : "down"}`
    document.title = `${d.symbol} ${this.fmtPrice(last)} · Stock Chart`
  }

  renderStats() {
    const c = this.candles
    const stats = [
      ["Open", this.fmtPrice(c[0].open)],
      ["High", this.fmtPrice(Math.max(...c.map((k) => k.high)))],
      ["Low", this.fmtPrice(Math.min(...c.map((k) => k.low)))],
      ["Volume", this.fmtVolume(c.reduce((sum, k) => sum + (k.volume || 0), 0))]
    ]
    this.statsTarget.replaceChildren(...stats.map(([label, value]) => {
      const div = document.createElement("div")
      const dt = document.createElement("dt")
      const dd = document.createElement("dd")
      dt.textContent = label
      dd.textContent = value
      div.append(dt, dd)
      return div
    }))
  }

  updateLegend(param) {
    if (!this.candles) return
    const n = this.candles.length
    const hovering = param?.point && param.logical != null
    const i = hovering ? Math.min(Math.max(Math.round(param.logical), 0), n - 1) : n - 1
    const k = this.candles[i]
    const cls = k.close >= k.open ? "up" : "down"

    const parts = [`<span>${this.formatTime(k.time)}</span>`]
    if (this.type === "candles") {
      parts.push(`<span>O <b>${this.fmtPrice(k.open)}</b></span>`,
                 `<span>H <b>${this.fmtPrice(k.high)}</b></span>`,
                 `<span>L <b>${this.fmtPrice(k.low)}</b></span>`)
    }
    parts.push(`<span>C <b class="change ${cls}">${this.fmtPrice(k.close)}</b></span>`)
    if (this.showVolume && k.volume) parts.push(`<span>V <b>${this.fmtVolume(k.volume)}</b></span>`)
    this.legendTarget.innerHTML = parts.join("")
  }

  // ---- theme ---------------------------------------------------------------

  applyTheme() {
    const s = getComputedStyle(document.documentElement)
    const v = (name) => s.getPropertyValue(name).trim()
    this.colors = { bg: v("--panel"), text: v("--muted"), grid: v("--grid"), border: v("--border"),
                    up: v("--up"), down: v("--down"), accent: v("--accent") }
    const c = this.colors

    this.chart.applyOptions({
      layout: { background: { type: "solid", color: c.bg }, textColor: c.text,
                fontFamily: getComputedStyle(document.body).fontFamily },
      grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
      rightPriceScale: { borderColor: c.border },
      timeScale: { borderColor: c.border }
    })
    this.styleSeries()
    this.setVolumeData()
  }

  styleSeries() {
    const c = this.colors
    if (!c || !this.mainSeries) return
    if (this.type === "candles") {
      this.mainSeries.applyOptions({ upColor: c.up, downColor: c.down, borderUpColor: c.up,
                                     borderDownColor: c.down, wickUpColor: c.up, wickDownColor: c.down })
    } else if (this.type === "line") {
      this.mainSeries.applyOptions({ color: c.accent })
    } else {
      this.mainSeries.applyOptions({ lineColor: c.accent, topColor: rgba(c.accent, 0.35),
                                     bottomColor: rgba(c.accent, 0) })
    }
  }

  // ---- ui helpers ----------------------------------------------------------

  syncButtons() {
    this.rangeButtonTargets.forEach((b) => this.mark(b, b.dataset.range === this.range))
    this.typeButtonTargets.forEach((b) => this.mark(b, b.dataset.type === this.type))
    this.mark(this.volumeButtonTarget, this.showVolume)
  }

  mark(button, on) {
    button.classList.toggle("on", on)
    button.setAttribute("aria-pressed", on)
  }

  updateUrl() {
    const p = new URLSearchParams({ symbol: this.symbol, range: this.range, type: this.type })
    if (!this.showVolume) p.set("volume", "0")
    history.replaceState(history.state, "", `?${p}`)
  }

  showOverlay(error = null) {
    this.overlayTarget.hidden = false
    this.overlayTarget.classList.toggle("error", Boolean(error))
    if (error) this.overlayTarget.textContent = error
    else this.overlayTarget.innerHTML = '<div class="spinner"></div>'
  }

  hideOverlay() {
    this.overlayTarget.hidden = true
  }

  // ---- formatting ----------------------------------------------------------

  precision() {
    const p = Math.abs(this.quote?.price ?? this.candles?.at(-1)?.close ?? 100)
    return p < 1 ? 4 : p < 10 ? 3 : 2
  }

  fmtPrice(v) {
    if (v == null || Number.isNaN(v)) return "—"
    const digits = this.precision()
    return v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })
  }

  fmtVolume(v) {
    return v ? new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(v) : "—"
  }

  // Intraday times arrive already shifted to exchange time, so they are shown as UTC.
  formatTime(t) {
    if (typeof t === "number") {
      return new Date(t * 1000).toLocaleString(undefined, {
        timeZone: "UTC", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
      })
    }
    const d = typeof t === "string" ? new Date(`${t}T00:00:00Z`) : new Date(Date.UTC(t.year, t.month - 1, t.day))
    return d.toLocaleDateString(undefined, { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" })
  }
}

function rgba(hex, alpha) {
  const h = hex.replace("#", "")
  const n = parseInt(h.length === 3 ? h.split("").map((x) => x + x).join("") : h, 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}
