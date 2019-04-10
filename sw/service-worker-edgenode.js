const WEBSITE = self.location.host
const MASTERNODE = self.location.host.origin
const MNLIST = 'https://'+ WEBSITE + '/masternode-cache-list'

// service worker cache polyfill
// importScripts('serviceworker-cache-polyfill.js')
const mime = require("mime/lite")

// install stage
self.addEventListener('install', function(event) {
  console.log("SW installing...");
});

// active stage
self.addEventListener('activate', function(event) {
  // delete all of the old caches (previous versions)
  event.waitUntil(deleteOldCaches(CACHE));
  event.waitUntil(console.log("SW ready!"))
})

// every time a resource is requested
self.addEventListener('fetch', function(event) {
  // race the network and cache
  if (isValidRequest(event.request)) {
    event.respondWith(networkCacheRace(event.request));
  } else {
    event.respondWith(fetch(event.request))
  }
});

// add a request/response pair to the cache
async function addToCache(request, response) {
  // if its already in cache then dont add it again
  const match = await caches.match(request)

  // if a match say we served from cache, if not then its network
  if (match) {
    console.log("NCR: served", request, "from cache")
    return
  } else {
    console.log("NCR: served", request, "from network")
  }

  // if it isn't in the cache, then add it
  const url = new URL(request)
  caches.open(CACHE).then(function(cache) {
    cache.put(request, response).then(() => {
      console.log("ATC:" ,url.pathname, "added to cache");
    })
  });
}

// check hash of response against expected hash (name of file from masternode)
async function assertHash(expectedHash, response) {
  const clone = await response.clone()
  const content = await clone.blob()
  const fr = new FileReader()
  fr.readAsArrayBuffer(content)
  return new Promise(function(resolve, reject) {
    fr.onloadend = async function() {
      // hash and compare the contents of the file with the expected hash
      // provided by the masternode
      const result = await crypto.subtle.digest('SHA-256', fr.result)
      let hash = bufferToHex(result)
      if (hash.toUpperCase() === expectedHash.toUpperCase()) {
        resolve(response)
      } else {
        reject(Error("CH: hash check failed.\nexpected: " + expectedHash + "\nactual: " + hash))
      }
    }
  })
}

// array buffer to hex
function bufferToHex(buffer) {
    var s = '', h = '0123456789ABCDEF';
    (new Uint8Array(buffer)).forEach((v) => { s += h[v >> 4] + h[v & 15]; });
    return s;
}

// delete old caches
function deleteOldCaches(currentCache) {
  // get a list of caches
  return caches.keys().then(keys => Promise.all(
    // for each cache
    keys.map(key => {
      // if it's not the currentCache
      if(!currentCache.includes(key)) {
        // delete it
        return caches.delete(key)
      }
    })
  ))
}

// fetch asset from an edgenode
async function fetchFromEdgeNode(request) {
  try {
    // convert the path to a hash
    const hash = await findHash(request.url)

    // use closest edgenode
    const edgenode = await findClosestNode()

    // call fetch for the edgenode
    const edgeURL = edgenode + "/content?website=" + WEBSITE + "&asset=" + hash
    const edgeResponse = await fetch(edgeURL)

    // assert that the content hash matches what's on the MN
    await assertHash(edgeResponse.clone(), hash)

    // rebuild response with the correct headers so it renders properly on page
    const rebuiltResponse = await rebuildResponse(edgeResponse.clone(), request.url)

    return rebuiltResponse
  } catch (err) {
    // if anything here goes wrong we can't do much but throw an error
    throw new Error("FED: " + err)
  }
}

// use the masternode list in cache to find the closest edgenode
async function findClosestNode() {
  // use the list from the cache to find the closest edgenode
  const cache = await caches.match(MNLIST)
  if (cache) {
    // we did find in the cache and now we can use it
    const list = await cache.json()
    // get the first thing in the list (the closest edgenode)
    const edgenode = list.edgeNodes[0]

    // we have the list, but the edgenode is not in the list
    if (!edgenode) {
      throw new Error("GCN: " + "list has no edgenodes!")
    }
    return hash
  }

  // we don't have the list
  throw new Error("GCN: masternode list not in cache");
}

// find hash from the masternode list in the cache
async function findHash(requestURL) {
  const url = new URL(requestURL)
  // asset name is everything after / + any query params
  const assetName = url.pathname + url.search

  // use the list from the cache to find the asset hash
  const cache = await caches.match(mnList)
  if (cache) {
    // we did find in the cache and now we can use it
    const list = await cache.json()
    const hash = list.assetHashes[assetName]

    // we have the list, but the asset is not in the list
    if (!hash) {
      throw new Error("FH: " + assetName + " not in list")
    }
    return hash
  }

  // we don't have the list
  throw new Error("FH: masternode list not in cache");
}

// resolves when the first promise resolves, rejects if all reject
async function firstSuccess(promises) {
  try {
    // go through all of the promises
    const err = await Promise.all(promises.map(p => {
      // on each promise we REJECT if the promise RESOLVES
      // this takes advantage of Promise.all rejection behavior
      // and lets us return the first resolved promise
      return p.then(val => Promise.reject(val), err => Promise.resolve(err))
    }))
    // if Promise.all resolves it should return an array of errors
    throw new Error("all promises failed")
  } catch (val) {
    // if Promise.all rejects then it should contain our result
    return val
  }
}

// wrapper that creates a promise that rejects if the asset is not in the cache
async function inCache(request) {
  return new Promise((resolve, reject) => {
    caches.match(request).then((req) => req ? resolve(req) : reject(Error("not in cache")));
  })
}

// validates if the request is even worth the SW's time
// for example we don't want the request if its a POST or from a different site
function isValidRequest(request) {
  return request.url.includes(WEBSITE) && request.method === 'GET';
}

// serve the content from cache if it's there, if not fallback to the network
async function networkCacheRace(request) {
  try {
    // we see which finishes first, the masternode fetch, edgenode fetch, or the disk cache.
    // here we count on the fact that MOST servers will have some caching headers
    // even if its just Etag or Last Modified. this approach takes advantage of
    // the memory cache of browsers. if the the mem cache has a fresh asset, we
    // can get it from there and not even have to run this logic. if it doesnt
    // then we race the masternode, edgenodes, and the cache.
    const response = await firstSuccess([fetch(request), fetchFromEdgeNode(request), inCache(request)])
    // if we get here, the browser didn't have a fresh copy of the asset in memory
    // lets try and add the asset to the cache asynchronously
    addToCache(request.url, response.clone())
    // if its the masternode list request, kick off the updateCache function
    if (request.url == MNLIST){
      updateCache(response.clone())
    }
    // serve the response from the winner of fetch vs disk cache
    return response
  } catch (err) {
    // if we get here that means the fetch failed and theres nothing in cache
    console.error(err);
    // lets just return the built in fallback svg
    return useFallback()
  }
}

// the edgenode just sends a body, so we need to rebuild the response
// with some headers so it can render correctly
async function rebuildResponse(response, assetName) {
  // this is just to give the root an .html extension
  if (assetName == "/") {
    assetName = "/index.html"
  }

  // use the mime pkg to match the mime type to the file extension
  const contentType = mime.getType(assetName)

  // extract the blob
  const blob = await response.blob()

  // if there is no matching content type there's nothing we can really do
  if(contentType) {
    return response.clone()
  }

  // build the new response
  const init = {
    "status" : res.status,
    headers: {
      "Content-Type": contentType,
    }
  }

  return new Response(blob, init)
}

// remove a request/response pair from the cache
async function removeFromCache(request) {
  const url = new URL(request)
  caches.open(CACHE).then(function(cache) {
    cache.delete(request)
    console.log("RFC:", url.pathname, "removed from cache");
  })
}

// update all cache entries based on the asset list we get from the masternode
async function updateCache(response) {
  let updateNeeded = false // keeps track if the masternode list needs to be updated
  const reqs = [] // holds all of our assets/requests we need to update

  // the cached list
  const list = await caches.match(MNLIST)
  if (!list) { // if we dont have the list dont bother updating anything
    return
  }

  // getting our last asset list from cache
  const listJson = await list.json()
  const cachedList = listJson.assetHashes

  // getting our latest asset list from network
  const res = await response.clone().json()
  const assetList = res.assetHashes

  // traverse the most current list
  for (const asset in assetList) {
    // see if the cached list has the asset
    if (cachedList[asset]) {
      // if it does NOT then add to the update list
      if (cachedList[asset] != assetList[asset]) {
        reqs.push("https://" + WEBSITE + asset)
        console.warn("UC:", asset, "out of date");
      }
    } else {
      // if the cached list doesnt have it, then we need to update the cached list
      updateNeeded = true
    }
  }

  // update the list if its out of date
  const cache = await caches.open(CACHE)
  if (updateNeeded) {
    cache.put(new Request(MNLIST), response.clone())
  }

  // update the cache
  cache.addAll(reqs)
}

// This fallback never fails since it uses embedded fallbacks.
function useFallback() {
  return Promise.resolve(new Response(FALLBACK, { headers: {
    'Content-Type': 'image/svg+xml'
  }}));
}

// The fallback is an embedded SVG image.
const FALLBACK =
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="180" stroke-linejoin="round">' +
  '  <path stroke="#DDD" stroke-width="25" d="M99,18 15,162H183z"/>' +
  '  <path stroke-width="17" fill="#FFF" d="M99,18 15,162H183z" stroke="#eee"/>' +
  '  <path d="M91,70a9,9 0 0,1 18,0l-5,50a4,4 0 0,1-8,0z" fill="#aaa"/>' +
  '  <circle cy="138" r="9" cx="100" fill="#aaa"/>' +
  '</svg>';

