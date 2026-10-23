import { Controller } from "@hotwired/stimulus"

export default class extends Controller {
  static targets = ["input", "list"]
  static values = { url: String }

  connect() {
    this.items = []
    this.active = -1
  }

  disconnect() {
    clearTimeout(this.timer)
    this.request?.abort()
  }

  search() {
    clearTimeout(this.timer)
    const query = this.inputTarget.value.trim()
    if (!query) return this.close()
    this.timer = setTimeout(() => this.load(query), 250)
  }

  async load(query) {
    this.request?.abort()
    this.request = new AbortController()
    try {
      const res = await fetch(`${this.urlValue}?q=${encodeURIComponent(query)}`, {
        signal: this.request.signal,
        headers: { Accept: "application/json" }
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Search failed")
      this.render(data)
    } catch (e) {
      if (e.name !== "AbortError") this.message(e.message)
    }
  }

  render(items) {
    this.items = items
    this.active = -1
    if (items.length === 0) return this.message("No matches")

    this.listTarget.replaceChildren(...items.map((item, i) => {
      const li = document.createElement("li")
      li.id = `suggestion-${i}`
      li.setAttribute("role", "option")
      li.append(
        this.span("sym", item.symbol),
        this.span("nm", item.name || ""),
        this.span("ex", [item.exchange, item.type].filter(Boolean).join(" · "))
      )
      // mousedown instead of click: fires before the input loses focus
      li.addEventListener("mousedown", (e) => { e.preventDefault(); this.choose(item) })
      return li
    }))
    this.open()
  }

  navigate(event) {
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp":
        if (this.listTarget.hidden || this.items.length === 0) return
        event.preventDefault()
        const step = event.key === "ArrowDown" ? 1 : -1
        this.highlight((this.active + step + this.items.length) % this.items.length)
        break
      case "Enter": {
        event.preventDefault()
        const typed = this.inputTarget.value.trim().toUpperCase()
        if (this.active >= 0) this.choose(this.items[this.active])
        else if (typed) this.choose({ symbol: typed })
        break
      }
      case "Escape":
        this.close()
        break
    }
  }

  highlight(index) {
    this.active = index
    this.listTarget.querySelectorAll("li").forEach((li, i) => {
      li.setAttribute("aria-selected", i === index)
      if (i === index) li.scrollIntoView({ block: "nearest" })
    })
    this.inputTarget.setAttribute("aria-activedescendant", `suggestion-${index}`)
  }

  choose(item) {
    clearTimeout(this.timer)
    this.inputTarget.value = item.symbol
    this.close()
    this.inputTarget.blur() // hides the keyboard on phones
    this.dispatch("select", { detail: item }) // -> "autocomplete:select"
  }

  open() {
    this.listTarget.hidden = false
    this.inputTarget.setAttribute("aria-expanded", "true")
  }

  close() {
    this.listTarget.hidden = true
    this.active = -1
    this.inputTarget.setAttribute("aria-expanded", "false")
    this.inputTarget.removeAttribute("aria-activedescendant")
  }

  message(text) {
    this.items = []
    const li = document.createElement("li")
    li.className = "empty"
    li.textContent = text
    this.listTarget.replaceChildren(li)
    this.open()
  }

  span(cls, text) {
    const s = document.createElement("span")
    s.className = cls
    s.textContent = text
    return s
  }
}
