package dev.yumeo.yumusic

import android.content.Intent
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import android.content.Context
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class IncomingLinksTest {
  @Before fun reset() { IncomingLinks.takePending() }

  @Test fun coldAndWarmLinksStayQueuedUntilTheFrontendConsumesThem() {
    val urls = listOf(
      "https://music.youtube.com/watch?v=abcdefghijk",
      "https://music.youtube.com/@_yumeo_",
      "https://music.youtube.com/playlist?list=PLexample",
      "https://music.youtube.com/browse/MPREexample"
    )
    urls.forEach { assertTrue(IncomingLinks.accept(Intent(Intent.ACTION_VIEW, Uri.parse(it)))) }
    val delivered = JSONArray(IncomingLinks.takePending())
    assertEquals(urls, (0 until delivered.length()).map { delivered.getString(it) })
    assertEquals("[]", IncomingLinks.takePending())
  }

  @Test fun sharedTextFindsTheMusicUrlAndRejectsForeignOrCredentialedUrls() {
    assertTrue(IncomingLinks.accept(Intent(Intent.ACTION_SEND).setType("text/plain")
      .putExtra(Intent.EXTRA_TEXT, "Listen to this\nhttps://music.youtube.com/watch?v=abcdefghijk")))
    assertEquals(1, JSONArray(IncomingLinks.takePending()).length())
    for (url in listOf("https://music.youtube.com.evil.test/watch?v=abcdefghijk", "https://user:password@music.youtube.com/watch?v=abcdefghijk", "file:///private"))
      assertFalse(IncomingLinks.accept(Intent(Intent.ACTION_VIEW, Uri.parse(url))))
  }

  @Test fun manifestAcceptsEveryMusicPathAndTheTextShareSheet() {
    val context = ApplicationProvider.getApplicationContext<Context>()
    for (path in listOf("/", "/watch?v=abcdefghijk", "/playlist?list=PLexample", "/browse/MPREexample", "/@_yumeo_", "/search?q=test")) {
      val intent = Intent(Intent.ACTION_VIEW, Uri.parse("https://music.youtube.com$path"))
        .addCategory(Intent.CATEGORY_BROWSABLE).setPackage(context.packageName)
      assertEquals("dev.yumeo.yumusic.MainActivity", context.packageManager.resolveActivity(intent, 0)?.activityInfo?.name)
    }
    val share = Intent(Intent.ACTION_SEND).setType("text/plain").setPackage(context.packageName)
    assertEquals("dev.yumeo.yumusic.MainActivity", context.packageManager.resolveActivity(share, 0)?.activityInfo?.name)
  }
}
