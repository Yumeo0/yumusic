package dev.yumeo.yumusic.audio

import java.io.IOException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test

class AudioByteQueueTest {
  @Test fun boundedBackpressurePreservesBytesAndFinishesAtEof() {
    val queue = AudioByteQueue(4)
    val generation = queue.restart()
    assertTrue(queue.append(generation, byteArrayOf(1, 2, 3, 4)))
    assertFalse(queue.append(generation, byteArrayOf(5)))
    val target = ByteArray(6)
    assertEquals(2, queue.read(generation, target, 0, 2) { false })
    assertTrue(queue.append(generation, byteArrayOf(5, 6)))
    queue.finish(generation)
    assertEquals(2, queue.read(generation, target, 2, 4) { false })
    assertEquals(2, queue.read(generation, target, 4, 2) { false })
    assertEquals(-1, queue.read(generation, target, 0, 6) { false })
    assertArrayEquals(byteArrayOf(1, 2, 3, 4, 5, 6), target)
  }

  @Test fun seekingWakesOldReaderAndRejectsLateChunks() {
    val queue = AudioByteQueue()
    val first = queue.restart()
    val worker = Executors.newSingleThreadExecutor()
    try {
      val waiting = worker.submit<Boolean> {
        try { queue.read(first, ByteArray(1), 0, 1) { false }; false }
        catch (_: IOException) { true }
      }
      val second = queue.restart()
      assertTrue(waiting.get(2, TimeUnit.SECONDS))
      assertTrue(queue.append(first, byteArrayOf(9)))
      assertTrue(queue.append(second, byteArrayOf(3)))
      val value = ByteArray(1)
      assertEquals(1, queue.read(second, value, 0, 1) { false })
      assertEquals(3, value[0].toInt())
    } finally { worker.shutdownNow() }
  }
}
