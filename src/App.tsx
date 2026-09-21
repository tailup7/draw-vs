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
  strokes: Stroke[]
}

type ToolMode = 'pen' | 'eraser' | 'pan'

const CANVAS_WIDTH = 900
const CANVAS_HEIGHT = 560

const DEFAULT_COLORS = [
  '#000000', '#ffffff', '#7f1d1d', '#dc2626', '#fb7185',
  '#9a3412', '#f97316', '#f59e0b', '#facc15', '#365314',
  '#65a30d', '#22c55e', '#10b981', '#0f766e', '#14b8a6',
  '#164e63', '#06b6d4', '#0284c7', '#2563eb', '#1d4ed8',
  '#3730a3', '#4f46e5', '#7c3aed', '#9333ea', '#c026d3',
  '#db2777', '#be185d', '#78350f', '#64748b', '#cbd5e1',
]

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
  const [selectedColor, setSelectedColor] = useState('#000000')
  const [brushSize, setBrushSize] = useState(2)
  const [toolMode, setToolMode] = useState<ToolMode>('pen')
  const [eraserCursor, setEraserCursor] = useState<Point | null>(null)
  const [connected, setConnected] = useState(false)
  const [game, setGame] = useState<RoomState | null>(null)
  const [strokes, setStrokes] = useState<Stroke[]>([])
  const [isDrawing, setIsDrawing] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [selfId] = useState(getPlayerId)

  const socketRef = useRef<WebSocket | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const activeStrokeRef = useRef<Stroke | null>(null)
  const pendingPointsRef = useRef<Point[]>([])
  const pointFlushTimerRef = useRef<number | null>(null)
  const playerIdRef = useRef(selfId)
  const activePointerIdRef = useRef<number | null>(null)
  const pointersRef = useRef(new Map<number, Point>())
  const panGestureRef = useRef<{ pointerId: number; x: number; y: number; panX: number; panY: number } | null>(null)
  const pinchGestureRef = useRef<{ distance: number; center: Point; zoom: number; panX: number; panY: number } | null>(null)

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

    canvas.width = Math.max(1, Math.round(CANVAS_WIDTH / zoom))
    canvas.height = Math.max(1, Math.round(CANVAS_HEIGHT / zoom))
    const canvasScale = canvas.clientWidth / canvas.width
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.setTransform(1, 0, 0, 1, pan.x / canvasScale, pan.y / canvasScale)

    const gridSpacing = 100
    const visibleLeft = -pan.x / canvasScale
    const visibleTop = -pan.y / canvasScale
    const visibleRight = visibleLeft + canvas.clientWidth / canvasScale
    const visibleBottom = visibleTop + canvas.clientHeight / canvasScale
    const firstVerticalLine = Math.floor(visibleLeft / gridSpacing) * gridSpacing
    const firstHorizontalLine = Math.floor(visibleTop / gridSpacing) * gridSpacing
    ctx.beginPath()
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.32)'
    ctx.lineWidth = 1 / Math.max(canvasScale, 0.01)
    for (let x = firstVerticalLine; x <= visibleRight; x += gridSpacing) {
      ctx.moveTo(x, visibleTop)
      ctx.lineTo(x, visibleBottom)
    }
    for (let y = firstHorizontalLine; y <= visibleBottom; y += gridSpacing) {
      ctx.moveTo(visibleLeft, y)
      ctx.lineTo(visibleRight, y)
    }
    ctx.stroke()

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
  }, [pan, strokes, zoom])

  const canDraw = game?.status === 'playing'

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
    }

    socket.onmessage = (event) => {
      const payload = JSON.parse(event.data) as {
        type?: string
        room?: RoomState
        message?: string
        stroke?: Stroke
        strokeId?: string
        points?: Point[]
        eraseIds?: string[]
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

      if (payload.type === 'draw:erase' && payload.eraseIds?.length) {
        const eraseIds = new Set(payload.eraseIds)
        setStrokes((previous) => previous.filter((stroke) => !eraseIds.has(stroke.id)))
      }
    }

    socket.onclose = () => {
      if (socketRef.current !== socket) {
        return
      }

      setConnected(false)
    }

    socket.onerror = () => {
      if (socketRef.current === socket) {
        setConnected(false)
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

  const getCanvasPoint = (event: ReactPointerEvent<HTMLDivElement>): Point => {
    const canvas = canvasRef.current
    if (!canvas) {
      return { x: 0, y: 0 }
    }

    const rect = canvas.getBoundingClientRect()
    const canvasScale = canvas.clientWidth / canvas.width
    return {
      x: (event.clientX - rect.left - pan.x) / canvasScale,
      y: (event.clientY - rect.top - pan.y) / canvasScale,
    }
  }

  const clampZoom = (value: number) => Math.min(3, Math.max(0.5, value))

  const getPointerCenter = (pointers: Map<number, Point>) => {
    const points = [...pointers.values()]
    return {
      x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
      y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
    }
  }

  const getPointerDistance = (pointers: Map<number, Point>) => {
    const points = [...pointers.values()]
    if (points.length < 2) {
      return 0
    }

    return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y)
  }

  const updateZoom = (nextZoom: number, anchor?: Point) => {
    const clampedZoom = clampZoom(nextZoom)
    if (anchor) {
      setPan((previous) => ({
        x: anchor.x - (anchor.x - previous.x) * clampedZoom / zoom,
        y: anchor.y - (anchor.y - previous.y) * clampedZoom / zoom,
      }))
    }
    setZoom(clampedZoom)
  }

  const finishActiveStroke = () => {
    const activeStroke = activeStrokeRef.current
    if (!activeStroke) {
      return
    }

    flushPendingPoints()
    sendMessage({
      type: 'draw:end',
      roomCode,
      playerId: playerIdRef.current,
      strokeId: activeStroke.id,
      stroke: activeStroke,
    })
    activeStrokeRef.current = null
    pendingPointsRef.current = []
    activePointerIdRef.current = null
    setIsDrawing(false)
  }

  const eraseAtPoint = (point: Point) => {
    const eraserRadius = brushSize / 2
    const erasedIds = strokes
      .filter((stroke) => stroke.points.some((strokePoint) => Math.hypot(strokePoint.x - point.x, strokePoint.y - point.y) <= eraserRadius))
      .map((stroke) => stroke.id)

    if (erasedIds.length === 0) {
      return
    }

    const erasedIdSet = new Set(erasedIds)
    setStrokes((previous) => previous.filter((stroke) => !erasedIdSet.has(stroke.id)))
    sendMessage({ type: 'draw:erase', roomCode, playerId: playerIdRef.current, eraseIds: erasedIds })
  }

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pointerPosition = { x: event.clientX, y: event.clientY }
    pointersRef.current.set(event.pointerId, pointerPosition)
    const viewportRect = event.currentTarget.getBoundingClientRect()
    setEraserCursor({ x: event.clientX - viewportRect.left, y: event.clientY - viewportRect.top })
    event.currentTarget.setPointerCapture(event.pointerId)

    if (pointersRef.current.size >= 2) {
      finishActiveStroke()
      const center = getPointerCenter(pointersRef.current)
      pinchGestureRef.current = {
        distance: getPointerDistance(pointersRef.current),
        center,
        zoom,
        panX: pan.x,
        panY: pan.y,
      }
      panGestureRef.current = null
      event.preventDefault()
      return
    }

    if (toolMode === 'pan') {
      panGestureRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y }
      event.preventDefault()
      return
    }

    if (!canDraw) {
      return
    }

    const point = getCanvasPoint(event)
    if (toolMode === 'eraser') {
      eraseAtPoint(point)
      activePointerIdRef.current = event.pointerId
      setIsDrawing(true)
      event.preventDefault()
      return
    }

    const stroke: Stroke = { id: crypto.randomUUID(), color: selectedColor, width: brushSize, points: [point] }
    activeStrokeRef.current = stroke
    activePointerIdRef.current = event.pointerId
    pendingPointsRef.current = []
    setIsDrawing(true)
    setStrokes((previous) => [...previous, stroke])
    sendMessage({ type: 'draw:start', roomCode, playerId: playerIdRef.current, stroke })
    event.preventDefault()
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    const viewportRect = event.currentTarget.getBoundingClientRect()
    setEraserCursor({ x: event.clientX - viewportRect.left, y: event.clientY - viewportRect.top })

    if (pinchGestureRef.current && pointersRef.current.size >= 2) {
      const gesture = pinchGestureRef.current
      const center = getPointerCenter(pointersRef.current)
      const distanceRatio = getPointerDistance(pointersRef.current) / gesture.distance
      setZoom(clampZoom(gesture.zoom * distanceRatio))
      setPan({ x: gesture.panX + center.x - gesture.center.x, y: gesture.panY + center.y - gesture.center.y })
      event.preventDefault()
      return
    }

    const panGesture = panGestureRef.current
    if (panGesture?.pointerId === event.pointerId) {
      setPan({ x: panGesture.panX + event.clientX - panGesture.x, y: panGesture.panY + event.clientY - panGesture.y })
      event.preventDefault()
      return
    }

    if (isDrawing && toolMode === 'eraser' && activePointerIdRef.current === event.pointerId) {
      eraseAtPoint(getCanvasPoint(event))
      event.preventDefault()
      return
    }

    if (!isDrawing || !activeStrokeRef.current || !canDraw || activePointerIdRef.current !== event.pointerId) {
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

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(event.pointerId)
    panGestureRef.current = null
    if (pointersRef.current.size < 2) {
      pinchGestureRef.current = null
    }

    if (activePointerIdRef.current === event.pointerId) {
      if (toolMode === 'pen') {
        finishActiveStroke()
      } else {
        activePointerIdRef.current = null
        setIsDrawing(false)
      }
    }
  }

  const handlePointerLeave = (event: ReactPointerEvent<HTMLDivElement>) => {
    setEraserCursor(null)
    handlePointerUp(event)
  }

  const handleClearBoard = () => {
    if (!canDraw) {
      return
    }

    setStrokes([])
    sendMessage({ type: 'clear', roomCode, playerId: playerIdRef.current })
  }

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    updateZoom(zoom * (event.deltaY < 0 ? 1.1 : 0.9), {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    })
  }

  const resetView = () => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }

  const palette = DEFAULT_COLORS
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
              game.players.map((player) => (
                <div key={player.id} className="player-card">
                  <span>{player.name}</span>
                  <small>{player.id === selfId ? 'You' : 'Opponent'}</small>
                  <em>{player.connected ? 'Connected' : 'Offline'}</em>
                </div>
              ))
            ) : (
              <p>Waiting for players...</p>
            )}
          </div>

          <div className="toolbar">
            <div className="tool-modes" aria-label="Drawing mode">
              <button type="button" className={toolMode === 'pen' ? 'selected' : ''} onClick={() => setToolMode('pen')} aria-label="Pen mode" title="Pen mode"><span className="tool-icon pen-icon" aria-hidden="true">✎</span></button>
              <button type="button" className={toolMode === 'eraser' ? 'selected' : ''} onClick={() => setToolMode('eraser')} aria-label="Eraser mode" title="Eraser mode"><span className="tool-icon eraser-icon" aria-hidden="true">▱</span></button>
              <button type="button" className={toolMode === 'pan' ? 'selected' : ''} onClick={() => setToolMode('pan')} aria-label="Pan mode" title="Pan mode"><span className="tool-icon pan-icon" aria-hidden="true">✋</span></button>
            </div>
            <label>{toolMode === 'eraser' ? 'Eraser size' : 'Brush size'}</label>
            <input type="range" min="1" max="8" value={brushSize} onChange={(event) => setBrushSize(Number(event.target.value))} />
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
            <button type="button" className="secondary-button" onClick={handleClearBoard} disabled={!canDraw}>
              Clear
            </button>
          </div>
        </div>

        <div className="panel board-panel">
          <div className="canvas-toolbar">
            <button type="button" className="zoom-button" onClick={() => updateZoom(zoom - 0.25)} aria-label="Zoom out">−</button>
            <span>{Math.round(zoom * 100)}%</span>
            <button type="button" className="zoom-button" onClick={() => updateZoom(zoom + 0.25)} aria-label="Zoom in">+</button>
            <button type="button" className="zoom-reset" onClick={resetView}>Reset view</button>
          </div>
          <div
            className={`canvas-viewport mode-${toolMode}`}
            onWheel={handleWheel}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerLeave}
            onPointerCancel={handlePointerUp}
          >
            <canvas ref={canvasRef} width={900} height={560} className="draw-canvas" />
            {toolMode === 'eraser' && eraserCursor && canvasRef.current && (
              <span
                className="eraser-cursor"
                style={{
                  left: eraserCursor.x,
                  top: eraserCursor.y,
                  width: brushSize * (canvasRef.current.clientWidth / canvasRef.current.width),
                  height: brushSize * (canvasRef.current.clientWidth / canvasRef.current.width),
                }}
                aria-hidden="true"
              />
            )}
          </div>
        </div>
      </section>
    </main>
  )
}

export default App
