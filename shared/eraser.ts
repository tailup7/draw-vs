export type Point = {
  x: number
  y: number
}

export type Stroke = {
  id: string
  color: string
  width: number
  points: Point[]
}

const pointsMatch = (first: Point, second: Point) => first.x === second.x && first.y === second.y

const interpolatePoint = (first: Point, second: Point, progress: number): Point => ({
  x: first.x + (second.x - first.x) * progress,
  y: first.y + (second.y - first.y) * progress,
})

const distanceToSegment = (point: Point, start: Point, end: Point) => {
  const deltaX = end.x - start.x
  const deltaY = end.y - start.y
  const segmentLengthSquared = deltaX * deltaX + deltaY * deltaY

  if (segmentLengthSquared === 0) {
    return Math.hypot(point.x - start.x, point.y - start.y)
  }

  const progress = Math.min(1, Math.max(0, ((point.x - start.x) * deltaX + (point.y - start.y) * deltaY) / segmentLengthSquared))
  return Math.hypot(point.x - (start.x + deltaX * progress), point.y - (start.y + deltaY * progress))
}

const isInsideEraserPath = (point: Point, eraserPath: Point[], radius: number) => {
  if (eraserPath.length === 1) {
    return Math.hypot(point.x - eraserPath[0].x, point.y - eraserPath[0].y) <= radius
  }

  for (let index = 1; index < eraserPath.length; index += 1) {
    if (distanceToSegment(point, eraserPath[index - 1], eraserPath[index]) <= radius) {
      return true
    }
  }

  return false
}

const findEraserBoundary = (start: Point, end: Point, startIsInside: boolean, eraserPath: Point[], radius: number) => {
  let lower = 0
  let upper = 1

  for (let iteration = 0; iteration < 12; iteration += 1) {
    const middle = (lower + upper) / 2
    const middleIsInside = isInsideEraserPath(interpolatePoint(start, end, middle), eraserPath, radius)

    if (middleIsInside === startIsInside) {
      lower = middle
    } else {
      upper = middle
    }
  }

  return interpolatePoint(start, end, (lower + upper) / 2)
}

const appendPoint = (points: Point[], point: Point) => {
  if (points.length === 0 || !pointsMatch(points[points.length - 1], point)) {
    points.push(point)
  }
}

const eraseStroke = (stroke: Stroke, eraserPath: Point[], eraserRadius: number, operationId: string): Stroke[] => {
  const radius = eraserRadius + stroke.width / 2

  if (stroke.points.length < 2) {
    return stroke.points.some((point) => isInsideEraserPath(point, eraserPath, radius)) ? [] : [stroke]
  }

  const fragments: Point[][] = []
  let fragment: Point[] = []
  let changed = false

  const finishFragment = () => {
    if (fragment.length >= 2) {
      fragments.push(fragment)
    }
    fragment = []
  }

  for (let segmentIndex = 1; segmentIndex < stroke.points.length; segmentIndex += 1) {
    const start = stroke.points[segmentIndex - 1]
    const end = stroke.points[segmentIndex]
    const segmentLength = Math.hypot(end.x - start.x, end.y - start.y)
    const steps = Math.max(1, Math.ceil(segmentLength / Math.max(1, Math.min(8, radius / 3))))
    let previousPoint = start
    let previousIsInside = isInsideEraserPath(previousPoint, eraserPath, radius)

    if (previousIsInside) {
      changed = true
    } else {
      appendPoint(fragment, previousPoint)
    }

    for (let step = 1; step <= steps; step += 1) {
      const nextPoint = interpolatePoint(start, end, step / steps)
      const nextIsInside = isInsideEraserPath(nextPoint, eraserPath, radius)

      if (previousIsInside !== nextIsInside) {
        changed = true
        const boundary = findEraserBoundary(previousPoint, nextPoint, previousIsInside, eraserPath, radius)

        if (previousIsInside) {
          appendPoint(fragment, boundary)
        } else {
          appendPoint(fragment, boundary)
          finishFragment()
        }
      }

      if (!nextIsInside) {
        appendPoint(fragment, nextPoint)
      } else {
        changed = true
      }

      previousPoint = nextPoint
      previousIsInside = nextIsInside
    }
  }

  finishFragment()

  if (!changed) {
    return [stroke]
  }

  return fragments.map((points, index) => ({
    ...stroke,
    id: index === 0 ? stroke.id : `${stroke.id}:erase:${operationId}:${index}`,
    points,
  }))
}

export const eraseStrokes = (strokes: Stroke[], eraserPath: Point[], eraserRadius: number, operationId: string) =>
  strokes.flatMap((stroke) => eraseStroke(stroke, eraserPath, eraserRadius, operationId))
