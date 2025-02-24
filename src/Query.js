import { SparseSet, Uint32SparseSet } from './Util.js'
import { $queryShadow, $storeFlattened, $storeSize, $tagStore, createShadow, parentArray } from './Storage.js'
import { $componentMap, registerComponent } from './Component.js'
import { $entityMasks, $entityEnabled, $entityArray, getEntityCursor, getDefaultSize, $entitySparseSet, getGlobalSize } from './Entity.js'
import { $size } from './World.js'

export function Not(c) { return function QueryNot() { return c } }
export function Or(c) { return function QueryOr() { return c } }
export function Changed(c) { return function QueryChanged() { return c } }

export const $queries = Symbol('queries')
export const $queryMap = Symbol('queryMap')
export const $dirtyQueries = Symbol('$dirtyQueries')
export const $queryComponents = Symbol('queryComponents')
export const $enterQuery = Symbol('enterQuery')
export const $exitQuery = Symbol('exitQuery')

export const enterQuery = query => world => {
  if (!world[$queryMap].has(query)) registerQuery(world, query)
  const q = world[$queryMap].get(query)
  return q.entered.splice(0)
}

export const exitQuery = query => world => {
  if (!world[$queryMap].has(query)) registerQuery(world, query)
  const q = world[$queryMap].get(query)
  return q.exited.splice(0)
}

export const registerQuery = (world, query) => {

  const components = []
  const notComponents = []
  const changedComponents = []

  query[$queryComponents].forEach(c => {
    if (typeof c === 'function') {
      const comp = c()
      if (!world[$componentMap].has(comp)) registerComponent(world, comp)
      if (c.name === 'QueryNot') {
        notComponents.push(comp)
      }
      if (c.name === 'QueryChanged') {
        changedComponents.push(comp)
        components.push(comp)
      }
    } else {
      if (!world[$componentMap].has(c)) registerComponent(world, c)
      components.push(c)
    }
  })

  const mapComponents = c => world[$componentMap].get(c)

  // const sparseSet = Uint32SparseSet(getGlobalSize())
  const sparseSet = SparseSet()

  const archetypes = []
  const changed = []
  const toRemove = []
  const entered = []
  const exited = []

  const generations = components
    .concat(notComponents)
    .map(mapComponents)
    .map(c => c.generationId)
    .reduce((a,v) => {
      if (a.includes(v)) return a
      a.push(v)
      return a
    }, [])

  const reduceBitflags = (a,c) => {
    if (!a[c.generationId]) a[c.generationId] = 0
    a[c.generationId] |= c.bitflag
    return a
  }
  const masks = components
    .map(mapComponents)
    .reduce(reduceBitflags, {})

  const notMasks = notComponents
    .map(mapComponents)
    .reduce((a,c) => {
      if (!a[c.generationId]) {
        a[c.generationId] = 0
        a[c.generationId] |= c.bitflag
      }
      return a
    }, {})

  // const orMasks = orComponents
  //   .map(mapComponents)
  //   .reduce(reduceBitmasks, {})

  const flatProps = components
    .filter(c => !c[$tagStore])
    .map(c => Object.getOwnPropertySymbols(c).includes($storeFlattened) ? c[$storeFlattened] : [c])
    .reduce((a,v) => a.concat(v), [])

  const shadows = flatProps.map(prop => {
      const $ = Symbol()
      createShadow(prop, $)
      return prop[$]
  }, [])

  const q = Object.assign(sparseSet, {
    archetypes,
    changed,
    components,
    notComponents,
    changedComponents,
    masks,
    notMasks,
    // orMasks,
    generations,
    flatProps,
    toRemove,
    entered,
    exited,
    shadows,
  })

  world[$queryMap].set(query, q)
  
  world[$queries].add(q)

  for (let eid = 0; eid < getEntityCursor(); eid++) {
    if (!world[$entitySparseSet].has(eid)) continue
    if (queryCheckEntity(world, q, eid)) {
      queryAddEntity(q, eid)
    }
  }
}

const diff = (q, clearDiff) => {
  if (clearDiff) q.changed.length = 0
  const { flatProps, shadows } = q
  for (let i = 0; i < q.dense.count(); i++) {
    const eid = q.dense[i]
    let dirty = false
    for (let pid = 0; pid < flatProps.length; pid++) {
      const prop = flatProps[pid]
      const shadow = shadows[pid]
      if (ArrayBuffer.isView(prop[eid])) {
        for (let i = 0; i < prop[eid].length; i++) {
          if (prop[eid][i] !== prop[eid][$queryShadow][i]) {
            dirty = true
            prop[eid][$queryShadow][i] = prop[eid][i]
          }
        }
      } else {
        if (prop[eid] !== shadow[eid]) {
          dirty = true
          shadow[eid] = prop[eid]
        }
      }
    }
    if (dirty) q.changed.push(eid)
  }
  return q.changed
}

export const defineQuery = (components) => {
  if (components === undefined || components[$componentMap] !== undefined) {
    return world => world ? world[$entityArray] : components[$entityArray]
  }

  const query = function (world, clearDiff=true) {
    if (!world[$queryMap].has(query)) registerQuery(world, query)

    const q = world[$queryMap].get(query)

    queryCommitRemovals(q)

    if (q.changedComponents.length) return diff(q, clearDiff)

    return q.dense
  }
  query[$queryComponents] = components
  return query
}

// TODO: archetype graph
export const queryCheckEntity = (world, q, eid) => {
  const { masks, notMasks, generations } = q
  // let or = true
  for (let i = 0; i < generations.length; i++) {
    const generationId = generations[i]
    const qMask = masks[generationId]
    const qNotMask = notMasks[generationId]
    // const qOrMask = orMasks[generationId]
    const eMask = world[$entityMasks][generationId][eid]
    
    if (qNotMask && (eMask & qNotMask) !== 0) {
      return false
    }
    // if (qOrMask && (eMask & qOrMask) !== qOrMask) {
    //   continue
    // }
    if (qMask && (eMask & qMask) !== qMask) {
      return false
    }
  }
  return true
}

export const queryCheckComponent = (world, q, component) => {
  const { generationId, bitflag } = world[$componentMap].get(component)
  const { masks } = q
  const mask = masks[generationId]
  return (mask & bitflag) === bitflag
}

export const queryAddEntity = (q, eid) => {
  if (q.has(eid)) return
  q.add(eid)
  q.entered.push(eid)
}

const queryCommitRemovals = (q) => {
  while (q.toRemove.length) {
    q.remove(q.toRemove.pop())
  }
}

export const commitRemovals = (world) => {
  world[$dirtyQueries].forEach(queryCommitRemovals)
  world[$dirtyQueries].clear()
}

export const queryRemoveEntity = (world, q, eid) => {
  if (!q.has(eid)) return
  q.toRemove.push(eid)
  world[$dirtyQueries].add(q)
  q.exited.push(eid)
}

export const resetChangedQuery = (world, query) => {
  const q = world[$queryMap].get(query)
  q.changed.length = 0
}

export const removeQuery = (world, query) => {
  const q = world[$queryMap].get(query)
  world[$queries].delete(q)
  world[$queryMap].delete(query)
}