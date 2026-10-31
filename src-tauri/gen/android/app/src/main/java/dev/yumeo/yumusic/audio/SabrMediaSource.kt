package dev.yumeo.yumusic.audio

import android.net.Uri
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.BaseDataSource
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.exoplayer.source.MediaSource
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy
import androidx.media3.extractor.Extractor
import androidx.media3.extractor.ExtractorInput
import androidx.media3.extractor.ExtractorOutput
import androidx.media3.extractor.ExtractorsFactory
import androidx.media3.extractor.PositionHolder
import androidx.media3.extractor.SeekMap
import androidx.media3.extractor.SeekPoint
import androidx.media3.extractor.TrackOutput
import androidx.media3.extractor.mkv.MatroskaExtractor
import androidx.media3.extractor.mp4.FragmentedMp4Extractor

/** SABR uses time-based requests, not HTTP byte ranges. Virtual seek offsets carry
 * milliseconds; each loader opens a fresh bounded pipe plus init segment at that time. */
@UnstableApi
class SabrMediaSource(
  private val mime: String,
  private val durationUs: Long,
  private val request: (Int, Long) -> Unit,
) {
  val queue = AudioByteQueue()

  fun create(item: MediaItem): MediaSource = ProgressiveMediaSource.Factory(
    DataSource.Factory { Pipe() },
    ExtractorsFactory { arrayOf(TimeExtractor()) },
  ).setLoadErrorHandlingPolicy(DefaultLoadErrorHandlingPolicy(0)).createMediaSource(item)

  private inner class Pipe : BaseDataSource(false) {
    @Volatile private var closed = false
    private var generation = 0
    private var uri: Uri? = null
    override fun open(spec: DataSpec): Long {
      transferInitializing(spec)
      closed = false
      uri = spec.uri
      generation = queue.restart()
      request(generation, if (spec.position == 0L) 0L else spec.position - 1)
      transferStarted(spec)
      return C.LENGTH_UNSET.toLong()
    }
    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
      val count = queue.read(generation, buffer, offset, length) { closed }
      if (count > 0) bytesTransferred(count)
      return count
    }
    override fun getUri(): Uri? = uri
    override fun close() { closed = true; queue.wake(); transferEnded() }
  }

  private inner class TimeExtractor : Extractor {
    private fun parser(): Extractor = if (mime.contains("webm"))
      MatroskaExtractor(MatroskaExtractor.FLAG_DISABLE_SEEK_FOR_CUES)
    else FragmentedMp4Extractor()
    private var delegate = parser()
    private lateinit var output: ExtractorOutput
    override fun sniff(input: ExtractorInput) = delegate.sniff(input)
    override fun init(output: ExtractorOutput) {
      this.output = object : ExtractorOutput {
        override fun track(id: Int, type: Int): TrackOutput = output.track(id, type)
        override fun endTracks() = output.endTracks()
        override fun seekMap(ignored: SeekMap) = output.seekMap(object : SeekMap {
          override fun isSeekable() = durationUs > 0
          override fun getDurationUs(): Long = if (this@SabrMediaSource.durationUs > 0) this@SabrMediaSource.durationUs else C.TIME_UNSET
          override fun getSeekPoints(timeUs: Long) = SeekMap.SeekPoints(SeekPoint(timeUs, if (timeUs == 0L) 0 else timeUs / 1000 + 1))
        })
      }
      delegate.init(this.output)
    }
    override fun read(input: ExtractorInput, holder: PositionHolder) = delegate.read(input, holder)
    override fun seek(position: Long, timeUs: Long) {
      delegate.release()
      delegate = parser()
      delegate.init(output)
      delegate.seek(0, timeUs)
    }
    override fun release() = delegate.release()
  }
}
