
import requests
from flask import Flask, request, jsonify

# --- Your original function, included unchanged ---
def get_target_price(symbol, eventStartTime, endDate):
    """
    Fetches the open price for a given crypto symbol from Polymarket.
    """
    url = "https://polymarket.com/api/crypto/crypto-price"
    params = {
        "symbol": symbol,
        "eventStartTime": eventStartTime,
        "endDate": endDate,
        "variant": "fifteen"
    }
    try:
        response = requests.get(url, params=params)
        # Raise an exception for bad status codes (4xx or 5xx)
        response.raise_for_status() 
        data = response.json()
        return data.get("openPrice")
    except requests.exceptions.RequestException as e:
        # Log the error for debugging
        print(f"Error fetching data from Polymarket: {e}")
        return None

# --- Flask App Setup ---
app = Flask(__name__)

# --- API Endpoint ---
@app.route('/get-target-price', methods=['GET'])
def api_get_target_price():
    """
    API endpoint to get the target price.
    Expects query parameters: symbol, eventStartTime, endDate
    Example: /get-target-price?symbol=BTC&eventStartTime=2023-01-01T00:00:00Z&endDate=2023-01-31T23:59:59Z
    """
    # 1. Get parameters from the request URL
    symbol = request.args.get('symbol')
    eventStartTime = request.args.get('eventStartTime')
    endDate = request.args.get('endDate')

    # 2. Validate that all required parameters are present
    if not all([symbol, eventStartTime, endDate]):
        return jsonify({
            "error": "Missing required parameters.",
            "message": "Please provide 'symbol', 'eventStartTime', and 'endDate' as query parameters."
        }), 400  # Bad Request

    # 3. Call the original function to get the data
    price = get_target_price(symbol, eventStartTime, endDate)

    # 4. Handle the response and potential errors
    if price is None:
        # This could be due to a network error or the symbol not being found
        return jsonify({
            "error": "Price not found.",
            "message": f"Could not retrieve the open price for symbol '{symbol}'. It may not exist or there was an external API issue."
        }), 404  # Not Found

    # 5. Return the successful response
    return jsonify({
        "symbol": symbol,
        "openPrice": price
    }), 200 # OK

# --- Run the App ---
if __name__ == '__main__':
    # Use debug=True for development, which provides helpful error messages and auto-reloads
    app.run(debug=True)
