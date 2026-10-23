Rails.application.routes.draw do
  root "stocks#index"
  get "stocks/search", to: "stocks#search"
  get "stocks/chart",  to: "stocks#chart"

  get "up" => "rails/health#show", as: :rails_health_check
end
