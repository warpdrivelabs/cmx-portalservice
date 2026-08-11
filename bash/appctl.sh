#!/bin/bash

# ================== 配置区 ==================
APP_NAME="cmx-portal-server"
APP_DIR="$(cd "$(dirname "$0")" && pwd)"  # 脚本所在目录
APP_BIN="$APP_DIR/cmx-portal-server"              # 二进制（与脚本同目录）
LOG_FILE="$APP_DIR/server.log"             # 日志文件
PID_FILE="$APP_DIR/server.pid"             # PID 文件
# ===========================================

export RUST_LOG="${RUST_LOG:-info}"

start() {
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if kill -0 "$PID" 2>/dev/null; then
            echo "[$APP_NAME] 已在运行 (PID: $PID)"
            exit 1
        else
            echo "[$APP_NAME] PID 文件存在但进程已退出，清理中..."
            rm -f "$PID_FILE"
        fi
    fi

    echo "[$APP_NAME] 正在启动..."

    if [ ! -x "$APP_BIN" ]; then
        echo "[$APP_NAME] 二进制文件不存在或无执行权限: $APP_BIN"
        exit 1
    fi

    cd "$APP_DIR" || exit 1

    nohup "$APP_BIN" > "$LOG_FILE" 2>&1 &
    PID=$!
    echo $PID > "$PID_FILE"

    sleep 2

    if kill -0 "$PID" 2>/dev/null; then
        echo "[$APP_NAME] 启动成功 (PID: $PID)"
        echo "[$APP_NAME] 日志文件: $LOG_FILE"
    else
        echo "[$APP_NAME] 启动失败，请查看日志: $LOG_FILE"
        rm -f "$PID_FILE"
        exit 1
    fi
}

stop() {
    if [ ! -f "$PID_FILE" ]; then
        echo "[$APP_NAME] 未运行（PID 文件不存在）"
        exit 1
    fi

    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
        echo "[$APP_NAME] 正在停止 (PID: $PID)..."
        kill "$PID"
        for i in $(seq 1 10); do
            if ! kill -0 "$PID" 2>/dev/null; then
                break
            fi
            sleep 1
        done
        if kill -0 "$PID" 2>/dev/null; then
            echo "[$APP_NAME] 强制终止 (超时)"
            kill -9 "$PID"
        fi
        rm -f "$PID_FILE"
        echo "[$APP_NAME] 已停止"
    else
        echo "[$APP_NAME] 进程已退出，清理 PID 文件"
        rm -f "$PID_FILE"
    fi
}

status() {
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if kill -0 "$PID" 2>/dev/null; then
            echo "[$APP_NAME] 运行中 (PID: $PID)"
            exit 0
        else
            echo "[$APP_NAME] PID 文件存在但进程已退出"
            exit 1
        fi
    else
        echo "[$APP_NAME] 未运行"
        exit 1
    fi
}

log() {
    if [ -f "$LOG_FILE" ]; then
        tail -f "$LOG_FILE"
    else
        echo "[$APP_NAME] 日志文件不存在: $LOG_FILE"
        exit 1
    fi
}

case "$1" in
    start)
        start
        ;;
    stop)
        stop
        ;;
    restart)
        stop
        sleep 2
        start
        ;;
    status)
        status
        ;;
    log)
        log
        ;;
    *)
        echo "用法: $0 {start|stop|restart|status|log}"
        exit 1
        ;;
esac
