package dev.yumeo.yumusic.audio

import android.media.audiofx.AudioEffect
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaSession
import java.io.File
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@UnstableApi
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PlaybackServiceTest {
  @Test fun sessionAdvertisesQueueControlsAndAnnouncesItsEffectsSession() {
    val controller = Robolectric.buildService(PlaybackService::class.java).create()
    val service = controller.get()
    try {
      assertSame(service, PlaybackService.instance)
      val field = PlaybackService::class.java.getDeclaredField("session").apply { isAccessible = true }
      val session = field.get(service) as MediaSession
      service.metadata(JSONObject().put("canGoNext", true).put("canGoPrevious", false))
      assertTrue(session.player.isCommandAvailable(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM))
      assertFalse(session.player.isCommandAvailable(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM))
      // System play requests follow the UI's room permissions.
      session.player.play()
      assertFalse(session.player.playWhenReady)
	  val file = File(service.cacheDir, "native-audio-test.m4a")
	  file.writeBytes(javaClass.getResourceAsStream("/audio/fragmented.m4a")!!.readBytes())
	  service.metadata(JSONObject().put("title", "Downloaded track").put("artist", "Artist"))
	  service.command(JSONObject().put("op", "load").put("deck", 0).put("id", "local-track").put("path", file.absolutePath))
	  assertEquals("Downloaded track", session.player.mediaMetadata.title.toString())
	  service.command(JSONObject().put("op", "stop").put("deck", 0).put("id", "old-track"))
	  assertEquals("local-track", session.player.currentMediaItem!!.mediaId)
	  service.command(JSONObject().put("op", "stop").put("deck", 0).put("id", "local-track"))
	  assertEquals(0, session.player.mediaItemCount)
      val effects = shadowOf(RuntimeEnvironment.getApplication()).broadcastIntents.filter { it.action == AudioEffect.ACTION_OPEN_AUDIO_EFFECT_CONTROL_SESSION }
      assertEquals(1, effects.size)
      assertTrue(effects.single().getIntExtra(AudioEffect.EXTRA_AUDIO_SESSION, 0) > 0)
    } finally { controller.destroy() }
    assertNull(PlaybackService.instance)
    assertTrue(shadowOf(RuntimeEnvironment.getApplication()).broadcastIntents.any { it.action == AudioEffect.ACTION_CLOSE_AUDIO_EFFECT_CONTROL_SESSION })
  }
}
