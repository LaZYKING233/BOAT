// network-test.js
Page({
  data: {
    ip: '192.168.8.100',
    port: '8765',
    connected: false,
    log: '',
    messageInput: ''
  },

  onUnload() {
    this.closeSocket()
  },

  onIpInput(e) {
    this.setData({ ip: e.detail.value })
  },

  onPortInput(e) {
    this.setData({ port: e.detail.value })
  },

  onMessageInput(e) {
    this.setData({ messageInput: e.detail.value })
  },

  appendLog(text) {
    const time = new Date().toLocaleTimeString()
    this.setData({ log: `[${time}] ${text}\n` + this.data.log })
  },

  connect() {
    const { ip, port } = this.data
    if (!ip || !port) {
      wx.showToast({ title: '请输入IP和端口', icon: 'none' })
      return
    }
    this.closeSocket()
    const url = `ws://${ip}:${port}`
    this.appendLog('正在连接 ' + url + ' ...')
    const socketTask = wx.connectSocket({ url })
    this._socketTask = socketTask

    socketTask.onOpen(() => {
      this.setData({ connected: true })
      this.appendLog('连接成功')
    })

    socketTask.onMessage((res) => {
      this.appendLog('收到: ' + res.data)
    })

    socketTask.onClose(() => {
      this.setData({ connected: false })
      this.appendLog('连接已关闭')
    })

    socketTask.onError((res) => {
      this.appendLog('连接错误: ' + JSON.stringify(res))
    })
  },

  disconnect() {
    this.closeSocket()
    this.appendLog('主动断开连接')
  },

  closeSocket() {
    if (this._socketTask) {
      try {
        this._socketTask.close()
      } catch (e) {}
      this._socketTask = null
      this.setData({ connected: false })
    }
  },

  sendMessage() {
    const msg = this.data.messageInput
    if (!msg) {
      wx.showToast({ title: '请输入消息', icon: 'none' })
      return
    }
    if (!this.data.connected || !this._socketTask) {
      wx.showToast({ title: '未连接', icon: 'none' })
      return
    }
    this._socketTask.send({
      data: msg,
      success: () => this.appendLog('已发送: ' + msg),
      fail: (err) => this.appendLog('发送失败: ' + JSON.stringify(err))
    })
    this.setData({ messageInput: '' })
  },

  clearLog() {
    this.setData({ log: '' })
  }
})
