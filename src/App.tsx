import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import './App.css'

type Point = {
  x: number
  y: number
}

type Stroke = {
  id: string
  color: string
  width: number
  points: Point[]
}

type Player = {
  id: string
  name: string
  connected: boolean
}

type RoomState = {
  roomCode: string
  status: 'waiting' | 'playing'
  players: Player[]
  currentTurnIndex: number
  round: number
  word: string
  strokes: Stroke[]
}

const DEFAULT_COLORS = ['#0f172a', '#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#f8fafc']

const getPlayerId = () => {
  const storedId = window.sessionStorage.getItem('draw-vs-player-id')
  if (storedId) {
    return storedId
  }

  const generatedId = crypto.randomUUID()
  window.sessionStorage.setItem('draw-vs-player-id', generatedId)
  return generatedId
}

const resolveSocketUrl = (roomCode: string, playerId: string, playerName: string) => {
  // The Cloudflare Vite plugin serves the app and Worker from one origin in
  // development, matching the deployed Cloudflare environment.
  const url = new URL('/ws', window.location.origin)
  url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('room', roomCode)
  url.searchParams.set('player', playerId)
  url.searchParams.set('name', playerName)
  return url.toString()
}

function App() {
  const [roomCode, setRoomCode] = useState('demo-room')
  const [playerName, setPlayerName] = useState('Player')
  const [selectedColor, setSelectedColor] = useState('#0f172a')
  const [brushSize, setBrushSize] = useState(5)
  const [statusText, setStatusText] = useState('部屋に参加して対戦を始めましょう')
  const [connected, setConnected] = useState(false)
  const [game, setGame] = useState<RoomState | null>(null)
  const [strokes, setStrokes] = useState<Stroke[]>([])
  const [isDrawing, setIsDrawing] = useState(false)
  const [selfId] = useState(getPlayerId)

  const socketRef = useRef<WebSocket | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const activeStrokeRef = useRef<Stroke | null>(null)
  const pendingPointsRef = useRef<Point[]>([])
  const pointFlushTimerRef = useRef<number | null>(null)
  const playerIdRef = useRef(selfId)

  useEffect(() => {
    const storedName = window.localStorage.getItem('draw-vs-player-name')

    if (storedName) {
      setPlayerName(storedName)
    }
  }, [])

  useEffect(() => {
    window.localStorage.setItem('draw-vs-player-name', playerName)
  }, [playerName])

  useEffect(() => () => {
    if (pointFlushTimerRef.current !== null) {
      window.clearTimeout(pointFlushTimerRef.current)
    }
    socketRef.current?.close()
    socketRef.current = null
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) {
      return
    }

    const ctx = canvas.getContext('2d')
    if (!ctx) {
      return
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    for (const stroke of strokes) {
      if (stroke.points.length === 0) {
        continue
      }

      ctx.beginPath()
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.strokeStyle = stroke.color
      ctx.lineWidth = stroke.width
      ctx.moveTo(stroke.points[0].x, stroke.points[0].y)

      for (let index = 1; index < stroke.points.length; index += 1) {
        ctx.lineTo(stroke.points[index].x, stroke.points[index].y)
      }

      ctx.stroke()
    }
  }, [strokes])

  const isMyTurn = Boolean(game && game.players[game.currentTurnIndex]?.id === selfId && game.status === 'playing')

  const handleJoin = () => {
    const name = playerName.trim() || 'Player'
    const room = roomCode.trim() || 'demo-room'

    if (socketRef.current) {
      socketRef.current.close()
    }

    const socket = new WebSocket(resolveSocketUrl(room, playerIdRef.current, name))
    socketRef.current = socket

    socket.onopen = () => {
      if (socketRef.current !== socket) {
        socket.close()
        return
      }

      setConnected(true)
      setStatusText('接続しました。対戦相手を待っています。')
    }

    socket.onmessage = (event) => {
      const payload = JSON.parse(event.data) as {
        type?: string
        room?: RoomState
        message?: string
        stroke?: Stroke
        strokeId?: string
        points?: Point[]
      }

      if (payload.type === 'state' && payload.room) {
        setGame(payload.room)
        const serverStrokes = payload.room.strokes ?? []
        setStrokes(() => {
          const activeStroke = activeStrokeRef.current
          if (!activeStroke) {
            return serverStrokes
          }

          const hasActiveStroke = serverStrokes.some((stroke) => stroke.id === activeStroke.id)
          return hasActiveStroke
            ? serverStrokes.map((stroke) => stroke.id === activeStroke.id ? activeStroke : stroke)
            : [...serverStrokes, activeStroke]
        })
        setStatusText(payload.room.status === 'waiting' ? '対戦相手を待っています。' : payload.room.players[payload.room.currentTurnIndex]?.id === playerIdRef.current ? 'あなたのターンです。描いてください。' : '相手のターンです。描く様子を見ることができます。')
      }

      if (payload.type === 'draw:start' && payload.stroke) {
        const receivedStroke = payload.stroke
        setStrokes((previous) => previous.some((stroke) => stroke.id === receivedStroke.id) ? previous : [...previous, receivedStroke])
      }

      if (payload.type === 'draw:points' && payload.strokeId && payload.points?.length) {
        const receivedStrokeId = payload.strokeId
        const receivedPoints = payload.points
        setStrokes((previous) => previous.map((stroke) => stroke.id === receivedStrokeId ? { ...stroke, points: [...stroke.points, ...receivedPoints] } : stroke))
      }

      if (payload.type === 'draw:clear') {
        setStrokes([])
      }

      if (payload.type === 'system' && payload.message) {
        setStatusText(payload.message)
      }
    }

    socket.onclose = () => {
      if (socketRef.current !== socket) {
        return
      }

      setConnected(false)
      setStatusText('接続が切れました。もう一度参加してください。')
    }

    socket.onerror = () => {
      if (socketRef.current === socket) {
        setStatusText('通信エラーが発生しました。')
      }
    }
  }

  const sendMessage = (payload: Record<string, unknown>) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(payload))
    }
  }

  const flushPendingPoints = () => {
    if (pointFlushTimerRef.current !== null) {
      window.clearTimeout(pointFlushTimerRef.current)
      pointFlushTimerRef.current = null
    }

    const activeStroke = activeStrokeRef.current
    const points = pendingPointsRef.current
    if (!activeStroke || points.length === 0) {
      return
    }

    pendingPointsRef.current = []
    sendMessage({
      type: 'draw:points',
      roomCode,
      playerId: playerIdRef.current,
      strokeId: activeStroke.id,
      points,
    })
  }

  const schedulePointFlush = () => {
    if (pointFlushTimerRef.current !== null) {
      return
    }

    // Keep local drawing immediate while sending compact batches frequently
    // enough for the opponent's canvas to appear real-time.
    pointFlushTimerRef.current = window.setTimeout(flushPendingPoints, 32)
  }

  const getCanvasPoint = (event: ReactPointerEvent<HTMLCanvasElement>): Point => {
    const canvas = canvasRef.current
    if (!canvas) {
      return { x: 0, y: 0 }
    }

    const rect = canvas.getBoundingClientRect()
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    }
  }

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!isMyTurn) {
      return
    }

    const point = getCanvasPoint(event)
    const stroke: Stroke = { id: crypto.randomUUID(), color: selectedColor, width: brushSize, points: [point] }
    activeStrokeRef.current = stroke
    pendingPointsRef.current = []
    setIsDrawing(true)
    setStrokes((previous) => [...previous, stroke])
    sendMessage({ type: 'draw:start', roomCode, playerId: playerIdRef.current, stroke })
    event.preventDefault()
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!isDrawing || !activeStrokeRef.current || !isMyTurn) {
      return
    }

    const point = getCanvasPoint(event)
    const activeStroke = activeStrokeRef.current
    activeStroke.points = [...activeStroke.points, point]
    activeStrokeRef.current = activeStroke
    pendingPointsRef.current.push(point)

    setStrokes((previous) =>
      previous.map((stroke) =>
        stroke.id === activeStroke.id
          ? { ...activeStroke, points: [...activeStroke.points] }
          : stroke,
      ),
    )

    schedulePointFlush()
  }

  const handlePointerUp = () => {
    if (!activeStrokeRef.current) {
      return
    }

    flushPendingPoints()
    sendMessage({
      type: 'draw:end',
      roomCode,
      playerId: playerIdRef.current,
      strokeId: activeStrokeRef.current.id,
      stroke: activeStrokeRef.current,
    })

    activeStrokeRef.current = null
    pendingPointsRef.current = []
    setIsDrawing(false)
  }

  const handleClearBoard = () => {
    if (!isMyTurn) {
      return
    }

    setStrokes([])
    sendMessage({ type: 'clear', roomCode, playerId: playerIdRef.current })
  }

  const handleNextTurn = () => {
    if (!isMyTurn) {
      return
    }

    sendMessage({ type: 'nextTurn', roomCode, playerId: playerIdRef.current })
  }

  const palette = DEFAULT_COLORS
  const currentPlayerName = game?.players.find((player) => player.id === selfId)?.name ?? playerName

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Cloudflare + Canvas</p>
          <h1>Draw VS</h1>
        </div>
        <div className={`connection-badge ${connected ? 'online' : 'offline'}`}>
          {connected ? 'Connected' : 'Offline'}
        </div>
      </header>

      <section className="panel controls-panel">
        <div className="control-group">
          <label htmlFor="room-name">Room</label>
          <input id="room-name" value={roomCode} onChange={(event) => setRoomCode(event.target.value)} />
        </div>

        <div className="control-group">
          <label htmlFor="player-name">Player</label>
          <input id="player-name" value={playerName} onChange={(event) => setPlayerName(event.target.value)} />
        </div>

        <button className="primary-button" onClick={handleJoin} type="button">
          {connected ? 'Reconnect' : 'Join room'}
        </button>
      </section>

      <section className="game-layout">
        <div className="panel side-panel">
          <h2>Players</h2>
          <div className="players-list">
            {game?.players.length ? (
              game.players.map((player, index) => (
                <div key={player.id} className={`player-card ${index === game.currentTurnIndex ? 'active' : ''}`}>
                  <span>{player.name}</span>
                  <small>{player.id === selfId ? 'You' : 'Opponent'}</small>
                  <em>{index === game.currentTurnIndex ? 'Drawing' : 'Waiting'}</em>
                </div>
              ))
            ) : (
              <p>Waiting for players...</p>
            )}
          </div>

          <div className="info-box">
            <span className="label">Round</span>
            <strong>{game ? game.round : 1}</strong>
          </div>

          <div className="info-box">
            <span className="label">Prompt</span>
            <strong>{game?.word ?? 'Ready'}</strong>
          </div>

          <div className="toolbar">
            <label>Brush</label>
            <input type="range" min="2" max="20" value={brushSize} onChange={(event) => setBrushSize(Number(event.target.value))} />
            <span>{brushSize}px</span>
          </div>

          <div className="palette" aria-label="Color palette">
            {palette.map((color) => (
              <button
                key={color}
                type="button"
                className={`color-button ${selectedColor === color ? 'selected' : ''}`}
                style={{ background: color }}
                onClick={() => setSelectedColor(color)}
                aria-label={`Select ${color}`}
              />
            ))}
          </div>

          <div className="action-row">
            <button type="button" className="secondary-button" onClick={handleClearBoard} disabled={!isMyTurn}>
              Clear
            </button>
            <button type="button" className="primary-button" onClick={handleNextTurn} disabled={!isMyTurn}>
              End turn
            </button>
          </div>
        </div>

        <div className="panel board-panel">
          <div className="board-header">
            <div>
              <p className="eyebrow">Status</p>
              <h2>{isMyTurn ? 'Your turn' : 'Opponent turn'}</h2>
            </div>
            <span className="player-tag">{currentPlayerName}</span>
          </div>

          <div className="status-bar">{statusText}</div>

          <canvas
            ref={canvasRef}
            width={900}
            height={560}
            className="draw-canvas"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerUp}
            onPointerCancel={handlePointerUp}
          />
        </div>
      </section>
    </main>
  )
}

export default App
