package dev.yumeo.yumusic.audio

import java.io.IOException
import java.util.ArrayDeque

/** Bounded compressed-audio pipe. The ExoPlayer loader blocks, never the UI thread. */
class AudioByteQueue(private val capacity: Int = 2 * 1024 * 1024) {
  private val lock = Object()
  private val chunks = ArrayDeque<ByteArray>()
  private var offset = 0
  private var bytes = 0
  private var epoch = 0
  private var ended = false
  private var failure: String? = null

  fun restart(): Int = synchronized(lock) {
    epoch++
    chunks.clear()
    offset = 0
    bytes = 0
    ended = false
    failure = null
    lock.notifyAll()
    epoch
  }

  fun append(generation: Int, data: ByteArray): Boolean = synchronized(lock) {
    if (generation != epoch || ended || failure != null) return true
    if (bytes + data.size > capacity) return false
    if (data.isNotEmpty()) { chunks.addLast(data); bytes += data.size }
    lock.notifyAll()
    true
  }

  fun finish(generation: Int, error: String? = null) = synchronized(lock) {
    if (generation == epoch) { ended = true; failure = error; lock.notifyAll() }
  }

  fun wake() = synchronized(lock) { lock.notifyAll() }

  fun read(generation: Int, target: ByteArray, start: Int, length: Int, cancelled: () -> Boolean): Int = synchronized(lock) {
    if (length == 0) return 0
    while (chunks.isEmpty() && !ended && failure == null && generation == epoch && !cancelled()) lock.wait()
    if (cancelled() || generation != epoch) throw IOException("Audio source replaced")
    failure?.let { throw IOException(it) }
    if (chunks.isEmpty()) return -1
    val head = chunks.first()
    val count = minOf(length, head.size - offset)
    head.copyInto(target, start, offset, offset + count)
    offset += count
    bytes -= count
    if (offset == head.size) { chunks.removeFirst(); offset = 0 }
    count
  }
}
