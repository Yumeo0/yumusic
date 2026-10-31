package dev.yumeo.yumusic.audio

import android.os.Looper
import androidx.media3.common.MediaItem
import androidx.media3.common.C
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.RenderersFactory
import androidx.media3.test.utils.FakeRenderer
import java.nio.ByteBuffer
import java.io.File
import java.time.Duration
import java.util.concurrent.CopyOnWriteArrayList
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@UnstableApi
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SabrMediaSourceTest {
  @Test fun downloadedSabrFilesHaveNativeSeekIndexesForBothContainers() {
    for ((resource, mime) in listOf("fragmented.m4a" to "audio/mp4", "fragmented.webm" to "audio/webm")) {
      val file = File(RuntimeEnvironment.getApplication().cacheDir, resource)
      file.writeBytes(javaClass.getResourceAsStream("/audio/$resource")!!.readBytes())
      val index = IndexedAudioFile.readIndex(file.absolutePath)
      assertTrue("$mime should have fragment timestamps", index.size > 5)
      assertTrue(index.zipWithNext().all { it.first.timeUs < it.second.timeUs && it.first.position < it.second.position })
      assertTrue(index.last().timeUs >= 17_000_000)
      val renderers = RenderersFactory { _, _, _, _, _ -> arrayOf(FakeRenderer(C.TRACK_TYPE_AUDIO)) }
      val player = ExoPlayer.Builder(RuntimeEnvironment.getApplication(), renderers).build()
      try {
        player.setMediaSource(IndexedAudioFile.create(MediaItem.fromUri(file.toURI().toString()), file.absolutePath, 20_000_000))
        player.prepare()
        await { player.playbackState == Player.STATE_READY }
        assertTrue("$mime downloads must be seekable", player.isCurrentMediaItemSeekable)
        player.seekTo(12_000)
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(20))
        await { player.playbackState == Player.STATE_READY && player.currentPosition == 12_000L }
        assertNull(player.playerError)
      } finally { player.release() }
    }
  }
  @Test fun fragmentedAudioLoadsAndSeeksByTimeWithoutAnHttpSeekIndex() {
    val bytes = javaClass.getResourceAsStream("/audio/fragmented.m4a")!!.readBytes()
    val boxes = mutableListOf<Pair<String, ByteArray>>()
    var cursor = 0
    while (cursor < bytes.size) {
      val size = ByteBuffer.wrap(bytes, cursor, 4).int
      require(size > 0)
      boxes += String(bytes, cursor + 4, 4, Charsets.US_ASCII) to bytes.copyOfRange(cursor, cursor + size)
      cursor += size
    }
    val init = boxes.takeWhile { it.first != "moof" }.flatMap { it.second.toList() }.toByteArray()
    val fragments = mutableListOf<ByteArray>()
    boxes.dropWhile { it.first != "moof" }.windowed(2, 2).forEach { pair ->
      if (pair[0].first == "moof" && pair[1].first == "mdat") fragments += pair[0].second + pair[1].second
    }
    verifySeeks("audio/mp4", init, fragments.mapIndexed { index, fragment -> index * 2000L to fragment })
  }

  @Test fun webmAudioLoadsAndSeeksByTimeWithoutCues() {
    val bytes = javaClass.getResourceAsStream("/audio/fragmented.webm")!!.readBytes()
    val starts = (0..bytes.size - 4).filter { i -> bytes[i] == 0x1f.toByte() && bytes[i + 1] == 0x43.toByte() && bytes[i + 2] == 0xb6.toByte() && bytes[i + 3] == 0x75.toByte() }
    val init = bytes.copyOfRange(0, starts.first())
    val fragments = starts.mapIndexed { index, start ->
      val fragment = bytes.copyOfRange(start, starts.getOrElse(index + 1) { bytes.size })
      // Skip Cluster ID and EBML size, then read its E7 timecode element.
      val sizeBytes = Integer.numberOfLeadingZeros(fragment[4].toInt() and 255) - 24 + 1
      val timecode = 4 + sizeBytes
      require(fragment[timecode] == 0xe7.toByte())
      val timeBytes = fragment[timecode + 1].toInt() and 127
      var time = 0L
      repeat(timeBytes) { time = (time shl 8) or (fragment[timecode + 2 + it].toLong() and 255) }
      time to fragment
    }
    verifySeeks("audio/webm", init, fragments)
  }

  private fun verifySeeks(mime: String, init: ByteArray, fragments: List<Pair<Long, ByteArray>>) {
    val requests = CopyOnWriteArrayList<Long>()
    lateinit var source: SabrMediaSource
    source = SabrMediaSource(mime, 20_000_000) { epoch, time ->
      requests += time
      source.queue.append(epoch, init)
      val selected = if (time == 0L) fragments.take(2) else fragments.drop((fragments.indexOfLast { it.first <= time }).coerceAtLeast(0))
      selected.forEach { source.queue.append(epoch, it.second) }
      if (time > 0) source.queue.finish(epoch)
    }
    val renderers = RenderersFactory { _, _, _, _, _ -> arrayOf(FakeRenderer(C.TRACK_TYPE_AUDIO)) }
    val player = ExoPlayer.Builder(RuntimeEnvironment.getApplication(), renderers).build()
    try {
      player.setMediaSource(source.create(MediaItem.fromUri("sabr://test")))
      player.prepare()
      await { player.playbackState == Player.STATE_READY }
      assertTrue(player.isCurrentMediaItemSeekable)
      assertEquals(20_000L, player.duration)
      player.seekTo(12_000)
      await { requests.contains(12_000L) && player.playbackState == Player.STATE_READY && player.currentPosition >= 12_000 }
      assertNull(player.playerError)
      assertTrue(player.currentPosition < 13_000)
      // Buffered seeks can stay entirely native; seeks beyond the loaded window
      // use the virtual offset and request a fresh SABR initialization segment.
      assertTrue("An unbuffered seek must restart SABR at the requested time", requests.contains(12_000L))
      player.seekTo(2_000)
      await { requests.contains(2_000L) && player.playbackState == Player.STATE_READY && player.currentPosition == 2_000L }
      assertNull(player.playerError)
    } finally { player.release() }
  }

  private fun await(predicate: () -> Boolean) {
    val deadline = System.nanoTime() + 5_000_000_000
    while (!predicate() && System.nanoTime() < deadline) {
      shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(10))
      Thread.sleep(5)
    }
    assertTrue("Native player did not become ready", predicate())
  }
}
