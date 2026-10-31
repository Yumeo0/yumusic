package dev.yumeo.yumusic.audio

import androidx.media3.common.MediaItem
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.FileDataSource
import androidx.media3.exoplayer.source.MediaSource
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import androidx.media3.extractor.DefaultExtractorsFactory
import androidx.media3.extractor.Extractor
import androidx.media3.extractor.ExtractorInput
import androidx.media3.extractor.ExtractorOutput
import androidx.media3.extractor.ExtractorsFactory
import androidx.media3.extractor.PositionHolder
import androidx.media3.extractor.SeekMap
import androidx.media3.extractor.SeekPoint
import androidx.media3.extractor.TrackOutput
import androidx.media3.extractor.mkv.MatroskaExtractor
import java.io.RandomAccessFile

/** SABR downloads often omit MP4 sidx/WebM cues. Index their fragment headers on
 * the loader thread; compressed audio continues to be read directly from disk. */
@UnstableApi
object IndexedAudioFile {
  fun create(item: MediaItem, path: String, durationUs: Long): MediaSource {
    val fileIndex by lazy { readIndex(path) }
    val factory = ExtractorsFactory {
      DefaultExtractorsFactory().setMatroskaExtractorFlags(MatroskaExtractor.FLAG_DISABLE_SEEK_FOR_CUES).createExtractors().map { parser -> object : Extractor {
        override fun sniff(input: ExtractorInput) = parser.sniff(input)
        override fun init(output: ExtractorOutput) = parser.init(object : ExtractorOutput {
          override fun track(id: Int, type: Int): TrackOutput = output.track(id, type)
          override fun endTracks() = output.endTracks()
          override fun seekMap(original: SeekMap) {
            val index = if (original.isSeekable) emptyList() else fileIndex
            output.seekMap(if (index.isEmpty()) original else object : SeekMap {
              override fun isSeekable() = true
              override fun getDurationUs() = if (durationUs > 0) durationUs else original.durationUs
              override fun getSeekPoints(timeUs: Long): SeekMap.SeekPoints {
                val i = index.indexOfLast { it.timeUs <= timeUs }.coerceAtLeast(0)
                val first = index[i]
                return if (i + 1 < index.size) SeekMap.SeekPoints(first, index[i + 1]) else SeekMap.SeekPoints(first)
              }
            })
          }
        })
        override fun read(input: ExtractorInput, holder: PositionHolder) = parser.read(input, holder)
        override fun seek(position: Long, timeUs: Long) = parser.seek(position, timeUs)
        override fun release() = parser.release()
      } }.toTypedArray()
    }
    return ProgressiveMediaSource.Factory(FileDataSource.Factory(), factory).createMediaSource(item)
  }

  internal fun readIndex(path: String): List<SeekPoint> = try {
    RandomAccessFile(path, "r").use { file ->
      if (file.length() < 12) emptyList()
      else { val magic = file.readInt(); file.seek(0); if (magic == 0x1a45dfa3) webm(file) else mp4(file) }
    }
  } catch (_: Exception) { emptyList() }

  private data class Atom(val type: String, val start: Long, val body: Long, val end: Long)
  private fun atom(file: RandomAccessFile, end: Long): Atom? {
    val start = file.filePointer
    if (start + 8 > end) return null
    var size = file.readInt().toLong() and 0xffffffffL
    val type = ByteArray(4).also(file::readFully).toString(Charsets.US_ASCII)
    if (size == 1L) size = file.readLong()
    if (size == 0L) size = end - start
    val body = file.filePointer
    if (size < body - start || size > end - start) return null
    return Atom(type, start, body, start + size)
  }
  private fun find(file: RandomAccessFile, from: Long, end: Long, type: String): Atom? {
    file.seek(from)
    while (file.filePointer < end) {
      val box = atom(file, end) ?: return null
      if (box.type == type) return box
      if (box.type in listOf("moov", "trak", "mdia", "moof", "traf")) {
        find(file, box.body, box.end, type)?.let { return it }
      }
      file.seek(box.end)
    }
    return null
  }
  private fun mp4(file: RandomAccessFile): List<SeekPoint> {
    val mdhd = find(file, 0, file.length(), "mdhd") ?: return emptyList()
    file.seek(mdhd.body)
    val version = file.readUnsignedByte()
    file.seek(mdhd.body + if (version == 1) 20 else 12)
    val scale = file.readInt().toLong() and 0xffffffffL
    if (scale == 0L) return emptyList()
    val points = mutableListOf<SeekPoint>()
    file.seek(0)
    while (file.filePointer < file.length()) {
      val box = atom(file, file.length()) ?: break
      if (box.type == "moof") {
        val tfdt = find(file, box.body, box.end, "tfdt")
        if (tfdt != null) {
          file.seek(tfdt.body)
          val longTime = file.readUnsignedByte() == 1
          file.seek(tfdt.body + 4)
          val time = if (longTime) file.readLong() else file.readInt().toLong() and 0xffffffffL
          points += SeekPoint(time * 1_000_000 / scale, if (points.isEmpty()) 0 else box.start)
        }
      }
      file.seek(box.end)
    }
    return points
  }

  private data class Element(val id: Long, val start: Long, val body: Long, val end: Long, val unknown: Boolean)
  private fun vint(file: RandomAccessFile, id: Boolean): Pair<Long, Boolean> {
    val first = file.readUnsignedByte()
    val length = Integer.numberOfLeadingZeros(first) - 24 + 1
    require(length in 1..8)
    var value = if (id) first.toLong() else (first and (255 ushr length)).toLong()
    repeat(length - 1) { value = (value shl 8) or file.readUnsignedByte().toLong() }
    return value to (!id && value == (1L shl (7 * length)) - 1)
  }
  private fun element(file: RandomAccessFile, limit: Long): Element? {
    val start = file.filePointer
    if (start >= limit) return null
    val id = vint(file, true).first
    val (size, unknown) = vint(file, false)
    val body = file.filePointer
    require(unknown || size <= limit - body)
    return Element(id, start, body, if (unknown) limit else body + size, unknown)
  }
  private fun unsigned(file: RandomAccessFile, size: Long): Long {
    require(size in 1..8)
    var value = 0L
    repeat(size.toInt()) { value = (value shl 8) or file.readUnsignedByte().toLong() }
    return value
  }
  private fun webm(file: RandomAccessFile): List<SeekPoint> {
    var segment: Element? = null
    while (file.filePointer < file.length()) {
      val next = element(file, file.length()) ?: break
      if (next.id == 0x18538067L) { segment = next; break }
      file.seek(next.end)
    }
    val end = segment?.end ?: return emptyList()
    var scale = 1_000_000L
    val points = mutableListOf<SeekPoint>()
    while (file.filePointer < end) {
      val next = element(file, end) ?: break
      if (next.id == 0x1549a966L) {
        while (file.filePointer < next.end) {
          val child = element(file, next.end) ?: break
          if (child.id == 0x2ad7b1L) scale = unsigned(file, child.end - child.body)
          file.seek(child.end)
        }
      } else if (next.id == 0x1f43b675L) {
        while (file.filePointer < next.end) {
          val child = element(file, next.end) ?: break
          if (child.id in listOf(0x1f43b675L, 0x1c53bb6bL)) { file.seek(child.start); break }
          if (child.id == 0xe7L) points += SeekPoint(unsigned(file, child.end - child.body) * scale / 1000, if (points.isEmpty()) 0 else next.start)
          file.seek(child.end)
          if (!next.unknown && points.lastOrNull()?.position == next.start) break
        }
        if (next.unknown) continue
      }
      file.seek(next.end)
    }
    return points
  }
}
