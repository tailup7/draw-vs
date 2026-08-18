import { DurableObject } from 'cloudflare:workers'

export interface Env extends Cloudflare.Env {
  DRAW_GAME: DurableObjectNamespace
}

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

type SocketAttachment = {
  roomCode?: string
  playerId?: string
  playerName?: string
  canDraw?: boolean
}

const WORD_BANK = ['cat', 'tree', 'rocket', 'beach', 'sun', 'flower', 'house', 'car', 'mountain', 'pizza']

const createRoom = (roomCode: string): RoomState => ({
  roomCode,
  status: 'waiting',
  players: [],
  currentTurnIndex: 0,
  round: 1,
  word: WORD_BANK[0],
  strokes: [],
})

const pickWord = () => WORD_BANK[Math.floor(Math.random() * WORD_BANK.length)]

export class DrawGameRoom extends DurableObject {
  private room?: RoomState
  private sockets = new Set<WebSocket>()
  private socketAttachments = new WeakMap<WebSocket, SocketAttachment>()

  private async getRoom(): Promise<RoomState> {
    if (this.room) {
      return this.room
    }

    const current = await this.ctx.storage.get<RoomState>('room')
    this.room = current ?? createRoom('demo-room')
    return this.room
  }

  private async persistRoom(room: RoomState) {
    this.room = room
    await this.ctx.storage.put('room', room)
  }

  private broadcast(room: RoomState) {
    this.broadcastEvent({ type: 'state', room })
  }

  private broadcastEvent(payload: unknown, excludedSocket?: WebSocket) {
    const message = JSON.stringify(payload)

    for (const socket of this.sockets) {
      if (socket === excludedSocket) {
        continue
      }

      try {
        socket.send(message)
      } catch {
        // Ignore socket errors while broadcasting to disconnected clients.
      }
    }
  }

  private getConnectedPlayerIds(excludedSocket?: WebSocket) {
    const playerIds = new Set<string>()

    for (const socket of this.sockets) {
      if (socket === excludedSocket) {
        continue
      }

      const attachment = this.socketAttachments.get(socket)
      if (attachment?.playerId) {
        playerIds.add(attachment.playerId)
      }
    }

    return playerIds
  }

  private removeDisconnectedPlayers(room: RoomState, excludedSocket?: WebSocket) {
    const connectedPlayerIds = this.getConnectedPlayerIds(excludedSocket)
    const seenPlayerIds = new Set<string>()

    room.players = room.players.filter((player) => {
      if (!connectedPlayerIds.has(player.id) || seenPlayerIds.has(player.id)) {
        return false
      }

      seenPlayerIds.add(player.id)
      return true
    })

    if (room.currentTurnIndex >= room.players.length) {
      room.currentTurnIndex = 0
    }
  }

  private updateTurnAttachments(room: RoomState) {
    const currentPlayerId = room.status === 'playing'
      ? room.players[room.currentTurnIndex]?.id
      : undefined

    for (const socket of this.sockets) {
      const attachment = this.socketAttachments.get(socket)
      if (!attachment) {
        continue
      }

      this.socketAttachments.set(socket, {
        ...attachment,
        canDraw: attachment.playerId === currentPlayerId,
      })
    }
  }

  async fetch(request: Request) {
    const url = new URL(request.url)

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 })
      }

      const roomCode = url.searchParams.get('room') ?? 'demo-room'
      const playerId = url.searchParams.get('player') ?? crypto.randomUUID()
      const playerName = url.searchParams.get('name') ?? 'Player'

      const existing = await this.getRoom()
      const room = existing.roomCode === roomCode ? existing : createRoom(roomCode)
      this.removeDisconnectedPlayers(room)
      room.status = room.players.length === 2 ? 'playing' : 'waiting'

      const existingPlayer = room.players.find((player) => player.id === playerId)
      if (!existingPlayer && room.players.length >= 2) {
        return new Response('Room is full', { status: 409 })
      }

      const webSocketPair = new WebSocketPair()
      const [client, server] = Object.values(webSocketPair) as [WebSocket, WebSocket]

      // Keep the room instance active while players are connected. The
      // hibernation API adds substantial per-message latency in local play,
      // while standard WebSocket events are appropriate for live drawing.
      server.accept()
      this.sockets.add(server)
      this.socketAttachments.set(server, { roomCode, playerId, playerName, canDraw: false })
      server.addEventListener('message', (event) => {
        void this.webSocketMessage(server, event.data as string | ArrayBuffer).catch(() => {
          server.close(1011, 'Failed to process message')
        })
      })
      server.addEventListener('close', () => {
        this.sockets.delete(server)
        void this.webSocketClose(server).finally(() => {
          this.socketAttachments.delete(server)
        })
      })
      server.addEventListener('error', () => {
        server.close(1011, 'WebSocket error')
      })

      room.roomCode = roomCode
      if (existingPlayer) {
        existingPlayer.name = playerName
        existingPlayer.connected = true
      } else {
        room.players.push({ id: playerId, name: playerName, connected: true })
      }

      const gameJustStarted = room.status === 'waiting' && room.players.length === 2
      room.status = room.players.length === 2 ? 'playing' : 'waiting'
      if (gameJustStarted) {
        room.word = pickWord()
        room.currentTurnIndex = 0
        room.round = 1
        room.strokes = []
      }
      this.updateTurnAttachments(room)
      await this.persistRoom(room)
      this.broadcast(room)

      return new Response(null, {
        status: 101,
        webSocket: client,
      })
    }

    if (url.pathname === '/health') {
      return Response.json({ ok: true })
    }

    return new Response('Not found', { status: 404 })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const attachment = this.socketAttachments.get(ws)
    const roomCode = attachment?.roomCode ?? 'demo-room'
    const playerId = attachment?.playerId ?? crypto.randomUUID()

    const payload = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message)) as {
      type?: string
      roomCode?: string
      playerId?: string
      name?: string
      stroke?: Stroke
      strokeId?: string
      point?: Point
      points?: Point[]
    }

    const senderId = playerId

    // Drawing events only need authorization from the socket attachment and
    // can be relayed without waking storage-backed room state.
    if (payload.type === 'draw:start' && payload.stroke) {
      if (!attachment?.canDraw) {
        return
      }

      this.broadcastEvent({ type: 'draw:start', stroke: payload.stroke }, ws)
      return
    }

    if (payload.type === 'draw:points' && payload.strokeId && payload.points?.length) {
      if (!attachment?.canDraw) {
        return
      }

      const nextPoints = payload.points.slice(0, 256)
      this.broadcastEvent({ type: 'draw:points', strokeId: payload.strokeId, points: nextPoints }, ws)
      return
    }

    const room = await this.getRoom()
    const activeRoom = room.roomCode === roomCode ? room : createRoom(roomCode)

    if (payload.type === 'join') {
      const target = activeRoom.players.find((player) => player.id === senderId)
      if (target) {
        target.name = payload.name ?? target.name
        target.connected = true
      }
      return
    }

    if (activeRoom.status !== 'playing') {
      return
    }

    if (payload.type === 'draw:end' && payload.stroke) {
      const isCurrentTurn = activeRoom.players[activeRoom.currentTurnIndex]?.id === senderId
      if (!isCurrentTurn) {
        return
      }

      const completedStroke = payload.stroke
      const existingStrokeIndex = activeRoom.strokes.findIndex((stroke) => stroke.id === completedStroke.id)
      if (existingStrokeIndex >= 0) {
        activeRoom.strokes[existingStrokeIndex] = completedStroke
      } else {
        activeRoom.strokes.push(completedStroke)
      }

      // Persist once per completed stroke. Persisting every pointer event
      // serializes the event stream and creates multi-second drawing latency.
      await this.persistRoom(activeRoom)
      return
    }

    if (payload.type === 'clear') {
      const isCurrentTurn = activeRoom.players[activeRoom.currentTurnIndex]?.id === senderId
      if (!isCurrentTurn) {
        return
      }

      activeRoom.strokes = []
      this.broadcastEvent({ type: 'draw:clear' }, ws)
      await this.persistRoom(activeRoom)
      return
    }

    if (payload.type === 'nextTurn') {
      const isCurrentTurn = activeRoom.players[activeRoom.currentTurnIndex]?.id === senderId
      if (!isCurrentTurn || activeRoom.players.length < 2) {
        return
      }

      activeRoom.currentTurnIndex = activeRoom.currentTurnIndex === 0 ? 1 : 0
      activeRoom.round += 1
      activeRoom.strokes = []
      activeRoom.word = pickWord()
      this.updateTurnAttachments(activeRoom)
      await this.persistRoom(activeRoom)
      this.broadcast(activeRoom)
    }
  }

  async webSocketClose(ws: WebSocket) {
    const attachment = this.socketAttachments.get(ws)
    const playerId = attachment?.playerId
    if (!playerId) {
      return
    }

    const room = await this.getRoom()
    const connectedPlayerIds = this.getConnectedPlayerIds(ws)

    // A reconnect can open the replacement socket before the old socket's
    // close event arrives. Keep the player if that replacement is connected.
    if (connectedPlayerIds.has(playerId)) {
      return
    }

    this.removeDisconnectedPlayers(room, ws)

    if (room.players.length === 0) {
      await this.ctx.storage.delete('room')
      this.room = undefined
      return
    }

    if (room.currentTurnIndex >= room.players.length) {
      room.currentTurnIndex = 0
    }

    room.status = room.players.length >= 2 ? 'playing' : 'waiting'
    this.updateTurnAttachments(room)
    await this.persistRoom(room)
    this.broadcast(room)
  }
}

export default {
  fetch(request, env) {
    const url = new URL(request.url)
    const roomCode = url.searchParams.get('room') ?? 'demo-room'
    const stub = env.DRAW_GAME.get(env.DRAW_GAME.idFromName(roomCode))

    if (url.pathname === '/api/health') {
      return Response.json({ ok: true })
    }

    return stub.fetch(request)
  },
} satisfies ExportedHandler<Env>
