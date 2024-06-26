import '../css/Trade.css'
import { Component } from 'react'
import { Socket } from '../../utility/Socket'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faRectangleXmark, faHouse, faRightFromBracket } from '@fortawesome/free-solid-svg-icons'
import TradingViewChart from './TradingViewChart'
import { Link } from 'react-router-dom'

class Trade extends Component {

  constructor(props) {
    super(props)
    this.state = {
      user: null,
      host: "localhost",
      port: 8082,
      coin: null,
      coins: [],
      balance: 0,
      available_assets: 0,
      market_value: 0,
      websocket: null,
      order_type: 'market',
      market_operations: [],
      market_operations_limit: 20,
      pending_orders: [],
      last_candlesticks: [],
      last_volumes: [],
      chart_granularity: 60,
      history_limit: 60 * 60 * 24,
      keepalive: 45000,
      time_zone_correction: 60 * 60 * 2
    }
  }

  componentDidMount() {
    let user = sessionStorage.getItem('user')
    if (!user) {
      window.location.href = '/login'
      return
    }

    let splitted_url = window.location.pathname.split('/')
    let coin = splitted_url[splitted_url.length - 1]

    // load configuration
    fetch('/config.json')
    .then(response => response.json())
    .then(config => {
      this.setState({
        user,
        coin,
        host: config.host,
        port: config.port,
        market_operations_limit: config.market_operations_limit,
        chart_granularity: config.chart_granularity,
        history_limit: config.history_limit,
        keepalive: config.keepalive,
        time_zone_correction: config.time_zone_correction
      }, () => this.initialize())
    })
    .catch(error => console.error(error));
  }

  formatQuantity = (quantity) => {
    if(!quantity || typeof quantity !== "number")
      return '0'
    quantity = quantity.toFixed(6)
    if (parseFloat(quantity) == 0)
      return `~0`
    return quantity
  }

  chartTimerCallback = () => {
    let date = new Date()
    let timestamp = parseInt(date.getTime() / (1000 * this.state.chart_granularity))
    if (this.state.last_candlesticks.length == 0 || (this.state.last_candlesticks.length > 0 && timestamp > parseInt(this.state.last_candlesticks.slice(-1)[0].time / this.state.chart_granularity))) {
      let last_candlesticks = [{
        time: parseInt(date.setSeconds(0, 0) / 1000),
        open: this.state.market_value,
        high: this.state.market_value,
        low: this.state.market_value,
        close: this.state.market_value
      }]
      let last_volumes = [{
        time: parseInt(date.setSeconds(0, 0) / 1000),
        value: 0,
        color: '#26a69a'
      }]
      this.setState({last_candlesticks, last_volumes})
    }
    setTimeout(() => this.chartTimerCallback(), 1000)
  }

  computeCandlestick = (new_timeseries, last_candlesticks, last_volumes) => {

    let new_candlestick = {...last_candlesticks.slice(-1)[0]}
    let new_volume = {...last_volumes.slice(-1)[0]}
    if (new_timeseries) {

      let new_time = parseInt((new Date(parseInt(new_timeseries.timestamp) / 1000000)).setSeconds(0, 0) / 1000)
      if (new_candlestick.time != new_time) {
        new_candlestick.open = new_candlestick.close
        new_candlestick.low = new_timeseries.market_value <= new_candlestick.open ? new_timeseries.market_value : new_candlestick.open
        new_candlestick.high = new_timeseries.market_value >= new_candlestick.open ? new_timeseries.market_value : new_candlestick.open
        new_candlestick.close = new_timeseries.market_value
        new_volume.value = new_timeseries.volume
      } else {
        if (new_candlestick.low >= new_timeseries.market_value)
          new_candlestick.low = new_timeseries.market_value

        if (new_candlestick.high <= new_timeseries.market_value)
          new_candlestick.high = new_timeseries.market_value

        new_candlestick.close = new_timeseries.market_value
        new_volume.value = new_timeseries.volume + new_volume.value
      }

      if (parseInt(new_timeseries.timestamp.slice(-9)) == 0) {
        new_candlestick.open = new_timeseries.market_value
        new_volume.volume = new_timeseries.volume
      }

      new_candlestick.time = new_time
      new_volume.time = new_time
      new_volume.color = new_candlestick.open > new_candlestick.close ? '#ef5350' : '#26a69a'
          
      last_candlesticks.push(new_candlestick)
      last_volumes.push(new_volume)
    }
  }

  deleteOrder = async (order) => {
    let url = 'http://' + this.state.host + ':' + this.state.port + '/api/order'
  
    let request = {
      uuid: order.key,
      coin: this.state.coin,
    }
    let response = await fetch(url, {
      method : 'DELETE',
      headers: {
        'Content-type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(request)
    })

    if (response.status != 200) {
      if (response.status == 500)
        alert('Internal server error')
      else
        alert(`Unknown error [${response.status}]`)
      return
    } 
    
    let available_assets = this.state.available_assets
    let balance = this.state.balance
    let pending_orders = [...this.state.pending_orders]

    if (order.type == 'sell') 
      available_assets += order.quantity
    else
      balance += order.quantity
    
    pending_orders = pending_orders.filter(function (pending_order) { return pending_order.key != order.key })

    this.setState({available_assets, balance, pending_orders})
  }

  updatePendingOrders = (balance, available_assets, pending_orders, transaction) => {
    for (let i = 0; i < pending_orders.length; i++) {
      if (transaction.buy_order_uuid == pending_orders[i].key) {
        pending_orders[i].quantity -= transaction.quantity * transaction.market_value
        available_assets += transaction.quantity
      } else if (transaction.sell_order_uuid == pending_orders[i].key) {
        pending_orders[i].quantity -= transaction.quantity
        balance += transaction.quantity * transaction.market_value
      }
    }
    pending_orders = pending_orders.filter(function (pending_order) { return pending_order.quantity > 0 })
    return [balance, available_assets, [...pending_orders]]
  }

  socketCallback = (message) => {
    switch (message.opcode) {
      case 'new_placed_order':

        if (message.transactions.length > 0) {
          let market_value = message.market_value
          let market_operations = [...this.state.market_operations]
          let balance = this.state.balance
          let available_assets = this.state.available_assets
          let pending_orders = [...this.state.pending_orders]
  
          let last_candlesticks = [{...this.state.last_candlesticks.slice(-1)[0]}]
          let last_volumes = [{...this.state.last_volumes.slice(-1)[0]}]

          let coins_dict = {}
          message.transactions.forEach(transaction => {

            coins_dict[transaction.coin] = transaction.new_market_value

            if (transaction.coin == this.state.coin) {
              // create new transaction
              let date = new Date(parseInt(transaction.timestamp) / 1000000)
              let new_transaction = {
                key: transaction.timestamp,
                market_value: transaction.market_value,
                quantity: transaction.quantity,
                timestamp: `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')}`,
                buy_order_uuid: transaction.buy_order_uuid,
                sell_order_uuid: transaction.sell_order_uuid,
                color: 'black'
              }

              // find position in the transaction list and set the color
              let i = 0
              while (i < market_operations.length) {
                if (market_operations[i].key < new_transaction.key) {
                  if (new_transaction.market_value > market_operations[i].market_value)
                    new_transaction.color = 'green'
                  else if (new_transaction.market_value == market_operations[i].market_value)
                    new_transaction.color = market_operations[i].color
                  else
                    new_transaction.color = 'red'
                  break
                }
                i++
              }

              // insert the new transaction in the transaction list
              market_operations = [
                ...market_operations.slice(0, i),
                new_transaction,
                ...market_operations.slice(i)
              ] 

              // update color of the transaction before the new one
              if (i > 0) {
                if (market_operations[i - 1].market_value > market_operations[i].market_value)
                  market_operations[i - 1].color = 'green'
                else if (market_operations[i - 1].market_value == market_operations[i].market_value)
                  market_operations[i - 1].color = market_operations[i].color
                else
                  market_operations[i - 1].color = 'red'
              }

              // check the transaction list limit
              if (market_operations.length > this.state.market_operations_limit)
                market_operations.pop()

              let res = this.updatePendingOrders(balance, available_assets, pending_orders, transaction)
              balance = res[0]
              available_assets = res[1]
              pending_orders = res[2]

              // add new timeseries to chart 
              let last_timeseries = {
                timestamp: transaction.timestamp,
                market_value: transaction.new_market_value,
                volume: transaction.quantity
              }
              this.computeCandlestick(last_timeseries, last_candlesticks, last_volumes)
            }
          })

          // update coins list panel
          let coins = [...this.state.coins]
          for(let i = 0; i < coins.length; i++)
            if (coins_dict[coins[i].coin])
              coins[i].market_value = coins_dict[coins[i].coin]

          this.setState({market_value, market_operations, last_candlesticks, last_volumes, coins, balance, available_assets, pending_orders})
        }
        break
    }
  }

  initialize = async () => {
    let user = this.state.user
    let coin = this.state.coin
    let keepalive = this.state.keepalive

    // load wallet from backend
    let url = 'http://' + this.state.host + ':' + this.state.port + '/api/wallet?user=' + user + '&coin=' + coin + '&balance=true'
    let response = await fetch(url, {
      method : 'GET',
      headers: {
        'Accept': 'application/json'
      }
    })

    if (response.status != 200) {
      alert('Get wallet failed')
      return
    }

    let json = await response.json()
    let balance = json.balance
    let available_assets = 0
    
    if (!Array.isArray(json.assets)) 
      available_assets = json.assets

    // load coins from backend
    let coins = []
    let market_value = 0
    url = 'http://' + this.state.host + ':' + this.state.port + '/api/coin'
    response = await fetch(url, {
      method : 'GET',
      headers: {
        'Accept': 'application/json'
      }
    })

    if (response.status != 200) {
      alert('Load coins failed')
      return
    }

    json = await response.json()
    if (Array.isArray(json.coins) && json.coins.length > 0) {
      coins = json.coins
      let coin_data = coins.filter(function(coin_data) { return coin_data.coin == coin })
      if (coin_data)
        market_value = coin_data[0].market_value
    }

    // load pending orders from backend
    url = 'http://' + this.state.host + ':' + this.state.port + '/api/order?user=' + user + '&coin=' + coin
    response = await fetch(url, {
      method : 'GET',
      headers: {
        'Accept': 'application/json'
      }
    })
    json = await response.json()

    let pending_orders = []
    if (Array.isArray(json.orders)) {
      json.orders.forEach(pending_order => {
        let date = new Date(parseInt(pending_order.timestamp) / 1000000)
        let new_pending_order = {
          key: pending_order.uuid,
          type: pending_order.type,
          quantity: pending_order.quantity,
          timestamp: `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')}`,
          limit: pending_order.limit
        }
        pending_orders = [
          new_pending_order,
          ...pending_orders
        ]
      })
    }

    // load transaction history
    url = 'http://' + this.state.host + ':' + this.state.port + '/api/transaction?coin=' + coin + '&seconds=' + this.state.history_limit
    response = await fetch(url, {
      method : 'GET',
      headers: {
        'Accept': 'application/json'
      }
    })
    json = await response.json()
    let history_candlesticks = []
    let history_volumes = []

    if (Array.isArray(json.transactions) && json.transactions.length > 0) {
      let date = new Date(json.transactions[0].timestamp / 1000000)
      history_candlesticks = [{
        time: parseInt(date.setSeconds(0, 0) / 1000),
        open: json.transactions[0].new_market_value,
        high: json.transactions[0].new_market_value,
        low: json.transactions[0].new_market_value,
        close: json.transactions[0].new_market_value
      }]
      history_volumes = [{
        time: parseInt(date.setSeconds(0, 0) / 1000),
        value: 1,
        color: '#26a69a'
      }]

      for (let i = 1; i < json.transactions.length; i++) {
        let last_time = parseInt((new Date(parseInt(json.transactions[i - 1].timestamp) / 1000000)).setSeconds(0, 0) / 1000)
        let new_time = parseInt((new Date(parseInt(json.transactions[i].timestamp) / 1000000)).setSeconds(0, 0) / 1000)
        
        // add all missing timeseries
        if (last_time != new_time) {
          for (let j = last_time + this.state.chart_granularity; j <= new_time; j += this.state.chart_granularity) {
            let new_timeseries = {
              timestamp: `${j}000000000`,
              market_value: json.transactions[i - 1].new_market_value,
              volume: 0
            }
            this.computeCandlestick(new_timeseries, history_candlesticks, history_volumes)
          } 
        }
        let new_timeseries = {
          timestamp: json.transactions[i].timestamp,
          market_value: json.transactions[i].new_market_value,
          volume: json.transactions[i].quantity
        }
        this.computeCandlestick(new_timeseries, history_candlesticks, history_volumes)

        if (i == json.transactions.length - 1) {
          let now = parseInt((new Date()).setSeconds(0, 0) / 1000)
          for (let j = new_time + this.state.chart_granularity; j <= now; j += this.state.chart_granularity) {
            let new_timeseries = {
              timestamp: `${j}000000000`,
              market_value: json.transactions[i].new_market_value,
              volume: 0
            }
            this.computeCandlestick(new_timeseries, history_candlesticks, history_volumes)
          } 
        }
      }
    }

    // open websocket to backend
    if (this.state.websocket)
      this.state.websocket.close()
    let websocket = new Socket(this.state.host, this.state.port, this.socketCallback, keepalive) 

    this.setState({
      balance,
      available_assets,
      user,
      coin,
      pending_orders, 
      market_value, 
      coins, 
      last_candlesticks: history_candlesticks, 
      last_volumes: history_volumes,
      websocket
    }, () => {
      this.chartTimerCallback()
    })
  }

  operation = async (type) => {
    let input_quantity = document.getElementById(type + '-input').value
    let limit = 0;
    if (this.state.order_type == 'limit')
      limit = parseFloat(type == 'buy' ? document.getElementsByClassName('limit-input')[0].value : document.getElementsByClassName('limit-input')[1].value)
    if(input_quantity == '') {
      alert('Invalid Quantity')
      return
    }
    let quantity = parseFloat(input_quantity)
    let url = 'http://' + this.state.host + ':' + this.state.port + '/api/order'
  
    let request = {
      type: type,
      user: this.state.user,
      coin: this.state.coin,
      quantity: quantity,
      limit: limit
    }
    let response = await fetch(url, {
      method : 'POST',
      headers: {
        'Content-type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(request)
    })

    if (response.status != 200 && response.status != 500) {
      alert(`Unknown error [${response.status}]`)
      return
    } 

    let json = await response.json()
    let balance = json.balance
    let available_assets = 0

    if (!Array.isArray(json.assets)) 
      available_assets = json.asset

    if (response.status == 500) {
      alert('Operation failed')
    } else {
      // create new order in pending order panel
      if (!Array.isArray(json.new_pending_order)) {
        let date = new Date(parseInt(json.new_pending_order.timestamp) / 1000000)
        let new_pending_order = {
          key: json.new_pending_order.uuid,
          type: type,
          quantity: json.new_pending_order.quantity,
          timestamp: `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')}`,
          limit: json.new_pending_order.limit
        }

        this.state.market_operations.forEach(transaction => {
          if (transaction.buy_order_uuid == new_pending_order) {
            new_pending_order.quantity -= transaction.quantity * transaction.market_value
            available_assets += transaction.quantity
          } else if (transaction.sell_order_uuid == new_pending_order.key) {
            new_pending_order.quantity -= transaction.quantity
            balance += transaction.quantity * transaction.market_value
          }
        })

        let pending_orders = [
          new_pending_order,
          ...this.state.pending_orders
        ]
        this.setState({pending_orders})
      }
      this.setState({balance, available_assets})
    }
  }

  render() {

    let limit_input = <></>
    if (this.state.order_type == 'market')
      limit_input = <input className='limit-input' type='number' placeholder='Market' disabled></input>
    else
      limit_input = <input className='limit-input' type='number' placeholder='Limit Market Value'></input>

    return (
      <div id='trade'>
        <div id='trade-header'>
          <label id='trade-user-label'>User: {this.state.user}</label>
          <Link id='trade-user-button' to='/user'>
            <FontAwesomeIcon style={{cursor: 'pointer'}} icon={faHouse} />
          </Link>
          <Link id='user-page-exit-button' to='/login'>
            <FontAwesomeIcon style={{cursor: 'pointer'}} icon={faRightFromBracket} />
          </Link>
        </div>

        <div id='trade-content'>
          <div id='trade-title-container'>
            <label id='title'>Trade {this.state.coin}</label>
            <label id='market-value'>Crypto Market Value: {this.formatQuantity(this.state.market_value)}€</label>
          </div>

          <div id='trade-content-2'>
            <div id='coin-info-container'>
              <div id='coin-list-container'>
                <div className='coin-container-header'>
                  <label style={{fontWeight: 'bold'}} className='coin-label-title'>Name</label>
                  <label style={{fontWeight: 'bold'}} className='coin-label-title'>Value</label>
                </div>   
                {
                  this.state.coins.map(coin => (
                    <Link
                      key = {coin.coin}
                      className='coin-container'
                      to={`/trade/${coin.coin}`}
                      reloadDocument={true}
                    >
                      <label className='coin-label'>{coin.coin}</label>
                      <label className='coin-label'>{this.formatQuantity(coin.market_value)}</label>
                    </Link>
                  ))
                }   
              </div>
              <TradingViewChart id='chart' last_candlesticks={this.state.last_candlesticks} last_volumes={this.state.last_volumes}/>
            </div>

            <div id='op-container'>
              <div id='op-header'>
                <button className='op-type' onClick={() => {this.setState({order_type: 'market'})}}>Market</button>
                <button className='op-type' onClick={() => {this.setState({order_type: 'limit'})}}>Limit</button>
              </div>
              <div className='op'>
                <h3>Buy</h3>
                <label id='balance'>Balance: {this.formatQuantity(this.state.balance)}€</label>
                <input id='buy-input' type='number' placeholder='Amount (euro)'></input>
                {limit_input}
                <button onClick={() => this.operation('buy')}>BUY</button>
              </div>
              <div className='op'>
                <h3>Sell</h3>
                <label id='available-cryptos'>Assets: {this.formatQuantity(this.state.available_assets)}</label>
                <input id='sell-input' type='number' placeholder='Amount (crypto)'></input>
                {limit_input}
                <button onClick={() => this.operation('sell')}>SELL</button>
              </div>
            </div>
          </div>

          <div id='real-time-info-container'>
            <div id='transaction-list-container'>
              <label className='list-title'>Market Operations</label>
              <div className='transaction-container'>
                <label style={{fontWeight: 'bold'}} className='transaction-label'>Price</label>
                <label style={{fontWeight: 'bold'}} className='transaction-label'>Quantity</label>
                <label style={{fontWeight: 'bold'}} className='transaction-label'>Time</label>
              </div>
              {
                this.state.market_operations.map(transaction => (
                  <div
                    key = {transaction.key}
                    className='transaction-container'
                  >
                    <label className='transaction-label' style={{color: transaction.color}}>{this.formatQuantity(transaction.market_value)}</label>
                    <label className='transaction-label'>{this.formatQuantity(transaction.quantity)}</label>
                    <label className='transaction-label'>{transaction.timestamp}</label>
                  </div>
                ))
              }
            </div>
            <div id='order-list-container'>
              <label className='list-title'>Pending Orders</label>
              <div className='order-container'>
                <label style={{fontWeight: 'bold'}} className='order-label'>Type</label>
                <label style={{fontWeight: 'bold'}} className='order-label'>Quantity</label>
                <label style={{fontWeight: 'bold'}} className='order-label'>Time</label>
                <label style={{fontWeight: 'bold'}} className='order-label'>Limit</label>
                <label style={{fontWeight: 'bold'}} className='remove-icon'></label>
              </div>
                {
                  this.state.pending_orders.map(order => (
                    <div
                      key = {order.key}
                      className='order-container'
                    >
                      <label className='order-label'>{order.type}</label>
                      <label className='order-label'>{this.formatQuantity(order.quantity)}</label>
                      <label className='order-label'>{order.timestamp}</label>
                      <label className='order-label'>{order.limit}</label>
                      <FontAwesomeIcon  className='remove-icon' style={{cursor: 'pointer'}} onClick={() => this.deleteOrder(order)} icon={faRectangleXmark} />
                    </div>
                  ))
                }
            </div>
          </div>
        </div>
      </div>
    )
  }
}

export default Trade
