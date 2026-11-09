import sys
import serial
import serial.tools.list_ports
import re
import base64
import time
from datetime import datetime
from io import BytesIO
from PyQt5.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
    QGroupBox, QLabel, QComboBox, QPushButton, QTextEdit, QLineEdit,
    QCheckBox, QStatusBar, QMessageBox, QListWidget, QFrame, QGridLayout
)
from PyQt5.QtCore import QTimer, QThread, pyqtSignal, Qt, QBuffer, QIODevice
from PyQt5.QtGui import QFont, QTextCursor, QKeyEvent, QClipboard, QPixmap, QImage


class SerialReadThread(QThread):
    data_received = pyqtSignal(bytes)

    def __init__(self, ser):
        super().__init__()
        self.ser = ser
        self.running = True

    def run(self):
        while self.running:
            if self.ser and self.ser.is_open:
                try:
                    data = self.ser.read_all()
                    if data:
                        self.data_received.emit(data)
                except Exception as e:
                    print(f"读取错误: {e}")
            self.msleep(10)

    def stop(self):
        self.running = False
        self.wait()


class CommandMenu(QFrame):
    command_selected = pyqtSignal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.commands = {
            '/help': '列出全部命令',
            '/send': '向串口发送信息 (用法: /send <内容>)',
            '/broadcast': '广播发送信息 (用法: /broadcast <内容>)',
            '/bind add': '绑定快捷代号 (用法: /bind add <代号> <内容>)',
            '/bind list': '列出全部绑定代号',
            '/bind del': '删除绑定代号 (用法: /bind del <代号>)',
        }
        self.filtered_commands = list(self.commands.keys())
        self.current_index = 0
        self.init_ui()

    def init_ui(self):
        self.setFrameStyle(QFrame.Box | QFrame.Raised)
        self.setStyleSheet("""
            CommandMenu {
                background-color: #2b2b2b;
                border: 1px solid #5a5a5a;
                border-radius: 5px;
            }
            QListWidget {
                background-color: #2b2b2b;
                border: none;
                color: #d4d4d4;
                font-family: Consolas, monospace;
            }
            QListWidget::item {
                padding: 5px;
                border-radius: 3px;
            }
            QListWidget::item:selected {
                background-color: #094771;
            }
            QListWidget::item:hover {
                background-color: #3c3c3c;
            }
        """)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(5, 5, 5, 5)
        
        self.list_widget = QListWidget()
        self.list_widget.itemClicked.connect(self.on_item_clicked)
        layout.addWidget(self.list_widget)
        
        self.refresh_list('/')
        self.hide()

    def refresh_list(self, filter_text=''):
        self.list_widget.clear()
        self.filtered_commands = []
        
        for cmd, desc in self.commands.items():
            if filter_text == '/' or filter_text.lower() in cmd.lower():
                self.list_widget.addItem(f"{cmd} - {desc}")
                self.filtered_commands.append(cmd)
        
        if self.filtered_commands:
            self.current_index = 0
            self.list_widget.setCurrentRow(0)

    def select_next(self):
        if self.filtered_commands:
            self.current_index = (self.current_index + 1) % len(self.filtered_commands)
            self.list_widget.setCurrentRow(self.current_index)

    def on_item_clicked(self, item):
        idx = self.list_widget.row(item)
        if 0 <= idx < len(self.filtered_commands):
            self.command_selected.emit(self.filtered_commands[idx])


class SerialAssistant(QMainWindow):
    IMG_START = "[IMG]"
    IMG_END = "[/IMG]"

    def __init__(self):
        super().__init__()
        self.serial_port = None
        self.read_thread = None
        self.bindings = {}
        self.command_menu_visible = False
        self.receive_buffer = b""
        self.current_user = None
        self.init_ui()
        self.refresh_ports()
        self.setup_connections()

    def keyPressEvent(self, event: QKeyEvent):
        if event.key() == Qt.Key_V and event.modifiers() == Qt.ControlModifier:
            self.paste_from_clipboard()
            return
        if event.key() == Qt.Key_Slash:
            if not self.send_edit.hasFocus():
                self.show_command_menu()
                self.send_edit.setFocus()
                self.send_edit.setText('/')
                return
        elif event.key() == Qt.Key_Escape:
            if self.command_menu_visible:
                self.hide_command_menu()
                self.send_edit.clear()
                return
        elif event.key() == Qt.Key_Tab:
            if self.command_menu_visible:
                self.command_menu.select_next()
                return
        super().keyPressEvent(event)

    def paste_from_clipboard(self):
        clipboard = QApplication.clipboard()
        mime_data = clipboard.mimeData()
        
        if mime_data.hasImage():
            image = clipboard.image()
            if not image.isNull():
                self.send_image_broadcast(image)
                return
        
        if mime_data.hasText():
            self.send_edit.paste()
            return

    def send_image_broadcast(self, image: QImage):
        if not self.serial_port or not self.serial_port.is_open:
            QMessageBox.warning(self, "警告", "串口未打开，无法发送！")
            return
        
        pixmap = QPixmap.fromImage(image)
        
        max_size = 150
        if pixmap.width() > max_size or pixmap.height() > max_size:
            pixmap = pixmap.scaled(max_size, max_size, Qt.KeepAspectRatio, Qt.SmoothTransformation)
        
        buffer = QBuffer()
        buffer.open(QIODevice.WriteOnly)
        pixmap.save(buffer, "PNG")
        img_data = buffer.data().data()
        
        img_base64 = base64.b64encode(img_data).decode('utf-8')
        
        chunks = [img_base64[i:i+180] for i in range(0, len(img_base64), 180)]
        
        timestamp = self.get_timestamp()
        total_chunks = len(chunks)
        
        self.append_to_receive(f"[广播图片] [{timestamp}] 共{total_chunks}个分片\n")
        
        success = True
        for i, chunk in enumerate(chunks):
            chunk_data = f"\xFF\xFF[IMG]{i+1}/{total_chunks}:{chunk}[/IMG]"
            if self.send_newline_check.isChecked():
                chunk_data += "\r\n"
            try:
                encoded = chunk_data.encode('utf-8')
                self.serial_port.write(encoded)
                self.serial_port.flush()
                time.sleep(0.08)
            except Exception as e:
                QMessageBox.critical(self, "错误", f"发送失败: {str(e)}")
                success = False
                break
        
        if success:
            self.status_bar.showMessage(f"已广播图片 ({total_chunks}个分片)", 2000)

    def init_ui(self):
        self.setWindowTitle("LoRa 串口调试助手")
        self.setMinimumSize(1000, 700)
        self.setStyleSheet("""
            QMainWindow {
                background-color: #2b2b2b;
            }
            QGroupBox {
                font: bold 12px;
                border: 1px solid #5a5a5a;
                border-radius: 5px;
                margin-top: 10px;
                padding-top: 10px;
                color: #d4d4d4;
                background-color: #3c3c3c;
            }
            QGroupBox::title {
                subcontrol-origin: margin;
                left: 20px;
                padding: 0 5px 0 5px;
            }
            QLabel {
                color: #d4d4d4;
            }
            QPushButton {
                background-color: #5a5a5a;
                border: none;
                border-radius: 4px;
                padding: 6px 12px;
                color: white;
                font-weight: bold;
            }
            QPushButton:hover {
                background-color: #6e6e6e;
            }
            QPushButton:pressed {
                background-color: #4a4a4a;
            }
            QPushButton:disabled {
                background-color: #3a3a3a;
                color: #808080;
            }
            QComboBox {
                background-color: #4a4a4a;
                border: 1px solid #5a5a5a;
                border-radius: 3px;
                padding: 4px;
                color: white;
            }
            QComboBox:editable {
                background-color: #4a4a4a;
            }
            QComboBox::drop-down {
                subcontrol-origin: padding;
                subcontrol-position: top right;
                width: 20px;
                border-left: 1px solid #5a5a5a;
            }
            QTextEdit {
                background-color: #1e1e1e;
                border: 1px solid #5a5a5a;
                border-radius: 3px;
                font-family: Consolas, monospace;
                font-size: 11pt;
                color: #d4d4d4;
            }
            QLineEdit {
                background-color: #1e1e1e;
                border: 1px solid #5a5a5a;
                border-radius: 3px;
                padding: 5px;
                font-family: Consolas, monospace;
                color: #d4d4d4;
            }
            QCheckBox {
                color: #d4d4d4;
            }
            QStatusBar {
                background-color: #2b2b2b;
                color: #b0b0b0;
            }
        """)

        central_widget = QWidget()
        self.setCentralWidget(central_widget)
        main_layout = QVBoxLayout(central_widget)
        main_layout.setSpacing(10)

        config_group = QGroupBox("串口配置")
        config_layout = QHBoxLayout()

        self.port_combo = QComboBox()
        self.port_combo.setMinimumWidth(150)
        self.baud_combo = QComboBox()
        self.baud_combo.addItems(["9600", "19200", "38400", "57600", "115200", "230400", "460800"])
        self.baud_combo.setCurrentText("115200")
        self.data_bits_combo = QComboBox()
        self.data_bits_combo.addItems(["8", "7", "6", "5"])
        self.stop_bits_combo = QComboBox()
        self.stop_bits_combo.addItems(["1", "1.5", "2"])
        self.parity_combo = QComboBox()
        self.parity_combo.addItems(["无", "奇校验", "偶校验"])

        self.open_btn = QPushButton("打开串口")
        self.refresh_btn = QPushButton("刷新端口")

        config_layout.addWidget(QLabel("串口:"))
        config_layout.addWidget(self.port_combo)
        config_layout.addWidget(QLabel("波特率:"))
        config_layout.addWidget(self.baud_combo)
        config_layout.addWidget(QLabel("数据位:"))
        config_layout.addWidget(self.data_bits_combo)
        config_layout.addWidget(QLabel("停止位:"))
        config_layout.addWidget(self.stop_bits_combo)
        config_layout.addWidget(QLabel("校验位:"))
        config_layout.addWidget(self.parity_combo)
        config_layout.addStretch()
        config_layout.addWidget(self.open_btn)
        config_layout.addWidget(self.refresh_btn)

        config_group.setLayout(config_layout)
        main_layout.addWidget(config_group)

        at_cmd_group = QGroupBox("AT命令快捷按钮 (配置模式下有效)")
        at_cmd_layout = QGridLayout()
        at_cmd_layout.setSpacing(5)

        self.at_buttons = []
        at_commands = [
            ("AT", "测试模块"),
            ("AT+MODEL?", "查询型号"),
            ("AT+CGMR?", "查询版本"),
            ("AT+RESET", "模块复位"),
            ("AT+ADDR?", "查询地址"),
            ("AT+TPOWER?", "查询功率"),
            ("AT+CWMODE?", "查询模式"),
            ("AT+WLRATE?", "查询速率"),
            ("AT+WLTIME?", "查询休眠"),
            ("AT+UART?", "查询串口"),
            ("AT+FLASH=1", "保存参数"),
            ("AT+ADDR=0,1", "设置地址"),
        ]

        for i, (cmd, desc) in enumerate(at_commands):
            btn = QPushButton(f"{desc}")
            btn.setToolTip(cmd)
            btn.setProperty("at_command", cmd)
            btn.clicked.connect(lambda checked, c=cmd: self.send_at_command(c))
            at_cmd_layout.addWidget(btn, i // 6, i % 6)
            self.at_buttons.append(btn)

        at_cmd_group.setLayout(at_cmd_layout)
        main_layout.addWidget(at_cmd_group)

        receive_group = QGroupBox("数据接收 (Ctrl+V 广播粘贴图片)")
        receive_layout = QVBoxLayout()
        self.receive_text = QTextEdit()
        self.receive_text.setReadOnly(True)
        self.clear_receive_btn = QPushButton("清空接收区")
        receive_layout.addWidget(self.receive_text)
        receive_layout.addWidget(self.clear_receive_btn, alignment=Qt.AlignRight)
        receive_group.setLayout(receive_layout)
        main_layout.addWidget(receive_group, 1)

        send_group = QGroupBox("数据发送 (全局按 / 键打开命令菜单)")
        send_layout = QVBoxLayout()
        
        self.send_edit = QLineEdit()
        self.send_edit.setPlaceholderText("输入数据发送，或按 / 键打开命令菜单...")
        
        self.command_menu = CommandMenu(self)
        self.command_menu.hide()

        send_btn_layout = QHBoxLayout()
        self.send_btn = QPushButton("发送")
        self.send_newline_check = QCheckBox("发送换行 (\\r\\n)")
        self.send_newline_check.setChecked(True)
        self.clear_send_btn = QPushButton("清空发送框")
        send_btn_layout.addWidget(self.send_btn)
        send_btn_layout.addWidget(self.send_newline_check)
        send_btn_layout.addStretch()
        send_btn_layout.addWidget(self.clear_send_btn)
        
        send_layout.addWidget(self.send_edit)
        send_layout.addWidget(self.command_menu)
        send_layout.addLayout(send_btn_layout)
        send_group.setLayout(send_layout)
        main_layout.addWidget(send_group)

        self.status_bar = QStatusBar()
        self.setStatusBar(self.status_bar)
        self.status_bar.showMessage("未连接 | 按 / 键打开命令菜单 | Ctrl+V 广播粘贴图片")

    def setup_connections(self):
        self.open_btn.clicked.connect(self.toggle_serial)
        self.refresh_btn.clicked.connect(self.refresh_ports)
        self.clear_receive_btn.clicked.connect(self.clear_receive)
        self.send_btn.clicked.connect(self.send_data)
        self.clear_send_btn.clicked.connect(lambda: self.send_edit.clear())
        self.send_edit.returnPressed.connect(self.on_enter_pressed)
        self.send_edit.textChanged.connect(self.on_text_changed)
        self.command_menu.command_selected.connect(self.on_command_selected)

    def on_enter_pressed(self):
        text = self.send_edit.text()
        if text.startswith('/'):
            self.execute_command(text)
        else:
            self.send_data()

    def on_text_changed(self, text):
        if text.startswith('/'):
            if not self.command_menu_visible:
                self.show_command_menu()
            self.command_menu.refresh_list(text)
        else:
            if self.command_menu_visible:
                self.hide_command_menu()

    def show_command_menu(self):
        self.command_menu_visible = True
        self.command_menu.refresh_list('/')
        self.command_menu.show()
        self.command_menu.setFixedWidth(self.send_edit.width())
        self.update_command_menu_position()

    def hide_command_menu(self):
        self.command_menu_visible = False
        self.command_menu.hide()

    def update_command_menu_position(self):
        edit_pos = self.send_edit.mapTo(self, self.send_edit.rect().bottomLeft())
        self.command_menu.move(edit_pos)

    def on_command_selected(self, cmd):
        self.send_edit.setText(cmd + " ")
        self.send_edit.setFocus()

    def execute_command(self, cmd_text):
        parts = cmd_text.split()
        if not parts:
            return

        cmd = parts[0].lower()
        args = parts[1:]

        if cmd == '/help':
            self.show_help()
        elif cmd == '/send':
            if args:
                content = ' '.join(args)
                content = self.apply_bindings(content)
                self.send_raw_data(content)
            else:
                self.append_to_receive("[错误] /send 需要参数，用法: /send <内容>\n")
        elif cmd == '/broadcast':
            if args:
                content = ' '.join(args)
                content = self.apply_bindings(content)
                self.send_broadcast(content)
            else:
                self.append_to_receive("[错误] /broadcast 需要参数，用法: /broadcast <内容>\n")
        elif cmd == '/bind':
            if args:
                sub_cmd = args[0].lower()
                if sub_cmd == 'add' and len(args) >= 3:
                    name = args[1]
                    value = ' '.join(args[2:])
                    self.bindings[name] = value
                    self.append_to_receive(f"[绑定] {name} -> {value}\n")
                elif sub_cmd == 'del' and len(args) >= 2:
                    name = args[1]
                    if name in self.bindings:
                        del self.bindings[name]
                        self.append_to_receive(f"[删除] 已删除绑定: {name}\n")
                    else:
                        self.append_to_receive(f"[错误] 未找到绑定: {name}\n")
                elif sub_cmd == 'list':
                    self.list_bindings()
                else:
                    self.append_to_receive("[错误] 用法: /bind add <代号> <内容> 或 /bind list 或 /bind del <代号>\n")
            else:
                self.append_to_receive("[错误] 用法: /bind add <代号> <内容> 或 /bind list 或 /bind del <代号>\n")
        elif cmd == '/login':
            if len(args) >= 2 and args[0].lower() == 'as':
                identity = ' '.join(args[1:])
                self.login_as(identity)
            else:
                self.append_to_receive("[错误] 用法: /login as <身份>\n")
        else:
            self.append_to_receive(f"[错误] 未知命令: {cmd}\n输入 /help 查看可用命令\n")

        self.send_edit.clear()
        self.hide_command_menu()

    def show_help(self):
        help_text = """命令帮助:
  /help              - 列出全部命令
  /send <内容>       - 向串口发送信息
  /broadcast <内容>  - 广播发送信息 (地址设为0xFFFF)
  /bind add <代号> <内容> - 绑定快捷代号
  /bind list         - 列出全部绑定代号
  /bind del <代号>   - 删除绑定代号

使用绑定: 在内容中使用 <代号> 格式，例如 /send <ciallo>
快捷键: Tab - 切换命令 | ESC - 退出菜单 | Ctrl+V - 广播粘贴图片
"""
        self.append_to_receive(help_text)

    def list_bindings(self):
        if not self.bindings:
            self.append_to_receive("[绑定列表] 当前无绑定\n")
        else:
            self.append_to_receive("[绑定列表]\n")
            for name, value in self.bindings.items():
                self.append_to_receive(f"  <{name}> -> {value}\n")

    def login_as(self, identity):
        identities = {
            'LingY': '小夏酱天下第一',
            'LaZY': 'LaZYKING',
        }
        
        if identity in identities:
            username = identities[identity]
            self.current_user = username
            
            messages = {
                'LingY': f'[系统] "{username}" 进入了直播间！！！✨🎉',
                'LaZY': f'[系统] "{username}" 降临直播间！！！👑🔥',
            }
            
            broadcast_msg = messages.get(identity, f'[系统] "{username}" 进入了直播间！！！')
            self.send_broadcast(broadcast_msg)
            self.append_to_receive(f"[登录] 已以 \"{username}\" 身份登录\n")
        else:
            self.append_to_receive(f"[错误] 未知身份: {identity}\n")

    def apply_bindings(self, text):
        pattern = r'<(\w+)>'
        def replace_binding(match):
            name = match.group(1)
            if name in self.bindings:
                return self.bindings[name]
            return match.group(0)
        return re.sub(pattern, replace_binding, text)

    def get_timestamp(self):
        return datetime.now().strftime("%H:%M:%S")

    def append_to_receive(self, text):
        self.receive_text.moveCursor(QTextCursor.End)
        self.receive_text.insertPlainText(text)
        self.receive_text.moveCursor(QTextCursor.End)

    def append_image_to_receive(self, pixmap: QPixmap, timestamp: str):
        self.receive_text.moveCursor(QTextCursor.End)
        cursor = self.receive_text.textCursor()
        cursor.insertText(f"[接收图片] [{timestamp}]\n")
        cursor.insertImage(pixmap.toImage())
        cursor.insertText("\n")
        self.receive_text.moveCursor(QTextCursor.End)

    def refresh_ports(self):
        ports = serial.tools.list_ports.comports()
        self.port_combo.clear()
        for port in ports:
            self.port_combo.addItem(f"{port.device} - {port.description}")
        if not ports:
            self.port_combo.addItem("无可用串口")
            self.port_combo.setEnabled(False)
            self.open_btn.setEnabled(False)
        else:
            self.port_combo.setEnabled(True)
            self.open_btn.setEnabled(True)

    def toggle_serial(self):
        if self.serial_port and self.serial_port.is_open:
            self.close_serial()
        else:
            self.open_serial()

    def open_serial(self):
        port_str = self.port_combo.currentText().split(" - ")[0]
        if not port_str or port_str == "无可用串口":
            QMessageBox.warning(self, "警告", "没有有效的串口可选！")
            return

        baud = int(self.baud_combo.currentText())
        data_bits = int(self.data_bits_combo.currentText())
        stop_bits = float(self.stop_bits_combo.currentText())
        parity_text = self.parity_combo.currentText()
        parity = self._get_parity(parity_text)

        try:
            self.serial_port = serial.Serial(
                port=port_str,
                baudrate=baud,
                bytesize=data_bits,
                stopbits=stop_bits,
                parity=parity,
                timeout=0.1,
                write_timeout=1.0
            )
            if self.serial_port.is_open:
                self.open_btn.setText("关闭串口")
                self.status_bar.showMessage(f"已连接 {port_str} @ {baud}bps | 按 / 键打开命令菜单 | Ctrl+V 广播粘贴图片")
                self.read_thread = SerialReadThread(self.serial_port)
                self.read_thread.data_received.connect(self.append_receive_data)
                self.read_thread.start()
                self._set_config_controls_enabled(False)
        except Exception as e:
            QMessageBox.critical(self, "错误", f"无法打开串口: {str(e)}")
            self.serial_port = None

    def close_serial(self):
        if self.read_thread:
            self.read_thread.stop()
            self.read_thread = None
        if self.serial_port and self.serial_port.is_open:
            self.serial_port.close()
        self.serial_port = None
        self.open_btn.setText("打开串口")
        self.status_bar.showMessage("未连接 | 按 / 键打开命令菜单 | Ctrl+V 广播粘贴图片")
        self._set_config_controls_enabled(True)

    def _get_parity(self, text):
        if text == "无":
            return serial.PARITY_NONE
        elif text == "奇校验":
            return serial.PARITY_ODD
        elif text == "偶校验":
            return serial.PARITY_EVEN
        return serial.PARITY_NONE

    def _set_config_controls_enabled(self, enabled):
        self.port_combo.setEnabled(enabled)
        self.baud_combo.setEnabled(enabled)
        self.data_bits_combo.setEnabled(enabled)
        self.stop_bits_combo.setEnabled(enabled)
        self.parity_combo.setEnabled(enabled)
        self.refresh_btn.setEnabled(enabled)

    def append_receive_data(self, data: bytes):
        self.receive_buffer += data
        
        text = self.receive_buffer.decode('utf-8', errors='replace')
        
        while '[/IMG]' in text:
            end_idx = text.find('[/IMG]')
            before_end = text[:end_idx]
            
            if '[IMG]' in before_end:
                start_idx = before_end.rfind('[IMG]')
                normal_text = before_end[:start_idx]
                img_content = before_end[start_idx + 5:]
                
                if normal_text:
                    self._display_normal_text(normal_text)
                
                self._process_image_chunk(img_content)
            else:
                self._display_normal_text(before_end + '[/IMG]')
            
            text = text[end_idx + 6:]
        
        if '[IMG]' in text:
            start_idx = text.find('[IMG]')
            normal_text = text[:start_idx]
            if normal_text:
                self._display_normal_text(normal_text)
            self.receive_buffer = text[start_idx:].encode('utf-8')
        else:
            if text:
                self._display_normal_text(text)
            self.receive_buffer = b""

    def _display_normal_text(self, text: str):
        text = text.replace('\xFF\xFF', '').replace('ÿÿ', '').replace('\x00', '')
        
        if text.strip():
            timestamp = self.get_timestamp()
            self.receive_text.moveCursor(QTextCursor.End)
            self.receive_text.insertPlainText(f"[接收信息] [{timestamp}] {text}")
            self.receive_text.moveCursor(QTextCursor.End)

    def _process_image_chunk(self, chunk: str):
        try:
            chunk = chunk.replace('[IMG]', '').replace('[/IMG]', '')
            
            if ':' in chunk:
                colon_pos = chunk.find(':')
                header = chunk[:colon_pos]
                base64_data = chunk[colon_pos + 1:]
                
                if '/' in header:
                    parts = header.split('/')
                    if len(parts) == 2:
                        current = int(parts[0])
                        total = int(parts[1])
                        
                        if not hasattr(self, 'image_chunks'):
                            self.image_chunks = {}
                        
                        if total not in self.image_chunks:
                            self.image_chunks[total] = {}
                        
                        self.image_chunks[total][current] = base64_data
                        
                        if len(self.image_chunks[total]) == total:
                            complete_base64 = ''.join(
                                self.image_chunks[total][i] 
                                for i in range(1, total + 1)
                            )
                            
                            img_data = base64.b64decode(complete_base64)
                            pixmap = QPixmap()
                            pixmap.loadFromData(img_data)
                            
                            if not pixmap.isNull():
                                timestamp = self.get_timestamp()
                                self.append_image_to_receive(pixmap, timestamp)
                            
                            del self.image_chunks[total]
        except Exception as e:
            print(f"图片处理错误: {e}")

    def clear_receive(self):
        self.receive_text.clear()
        self.receive_buffer = b""
        if hasattr(self, 'image_chunks'):
            self.image_chunks = {}

    def send_at_command(self, cmd):
        if not self.serial_port or not self.serial_port.is_open:
            QMessageBox.warning(self, "警告", "串口未打开，无法发送！")
            return
        data = cmd + "\r\n"
        try:
            self.serial_port.write(data.encode('utf-8'))
            timestamp = self.get_timestamp()
            self.append_to_receive(f"[发送] [{timestamp}] {cmd}\n")
            self.status_bar.showMessage(f"已发送: {cmd}", 2000)
        except Exception as e:
            QMessageBox.critical(self, "错误", f"发送失败: {str(e)}")

    def send_raw_data(self, data):
        if not self.serial_port or not self.serial_port.is_open:
            QMessageBox.warning(self, "警告", "串口未打开，无法发送！")
            return
        if self.send_newline_check.isChecked():
            data += "\r\n"
        try:
            self.serial_port.write(data.encode('utf-8'))
            timestamp = self.get_timestamp()
            self.append_to_receive(f"[发送] [{timestamp}] {data.strip()}\n")
            self.status_bar.showMessage(f"已发送: {data[:30]}", 2000)
        except Exception as e:
            QMessageBox.critical(self, "错误", f"发送失败: {str(e)}")

    def send_broadcast(self, data):
        if not self.serial_port or not self.serial_port.is_open:
            QMessageBox.warning(self, "警告", "串口未打开，无法发送！")
            return
        broadcast_frame = f"\xFF\xFF{data}"
        if self.send_newline_check.isChecked():
            broadcast_frame += "\r\n"
        try:
            self.serial_port.write(broadcast_frame.encode('utf-8'))
            timestamp = self.get_timestamp()
            self.append_to_receive(f"[广播] [{timestamp}] {data}\n")
            self.status_bar.showMessage(f"已广播: {data[:30]}", 2000)
        except Exception as e:
            QMessageBox.critical(self, "错误", f"广播失败: {str(e)}")

    def send_data(self):
        if not self.serial_port or not self.serial_port.is_open:
            QMessageBox.warning(self, "警告", "串口未打开，无法发送！")
            return
        data = self.send_edit.text()
        if not data:
            return
        data = self.apply_bindings(data)
        if self.send_newline_check.isChecked():
            data += "\r\n"
        try:
            self.serial_port.write(data.encode('utf-8'))
            timestamp = self.get_timestamp()
            self.append_to_receive(f"[发送] [{timestamp}] {data.strip()}\n")
            self.status_bar.showMessage(f"已发送: {data[:30]}", 2000)
        except Exception as e:
            QMessageBox.critical(self, "错误", f"发送失败: {str(e)}")
        self.send_edit.clear()

    def resizeEvent(self, event):
        super().resizeEvent(event)
        if self.command_menu_visible:
            self.update_command_menu_position()

    def closeEvent(self, event):
        self.close_serial()
        event.accept()


def main():
    app = QApplication(sys.argv)
    font = QFont("Segoe UI", 9)
    app.setFont(font)
    window = SerialAssistant()
    window.show()
    sys.exit(app.exec_())


if __name__ == "__main__":
    main()
