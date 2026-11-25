package com.putmantechnologies.account

import android.content.Intent
import android.net.Uri
import android.os.SystemClock
import android.util.Base64
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.SocketTimeoutException
import java.security.MessageDigest
import java.security.SecureRandom
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class PutmanCodeAccountModule : Module() {
  private fun encoded(bytes: ByteArray): String =
    Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)

  private fun random(size: Int): String = encoded(ByteArray(size).also { SecureRandom().nextBytes(it) })

  override fun definition() = ModuleDefinition {
    Name("PutmanCodeAccount")
    AsyncFunction("authorize") Coroutine { endpoint: String, client: String, scope: String ->
      require(Uri.parse(endpoint).host == "login.microsoftonline.com" && Uri.parse(endpoint).scheme == "https")
      val activity = appContext.currentActivity ?: error("Open PutmanCode to sign in.")
      val state = random(32)
      val verifier = random(48)
      val challenge = encoded(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray()))
      withContext(Dispatchers.IO) {
        ServerSocket().use { server ->
          server.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0))
          val redirect = "http://localhost:${server.localPort}"
          val url = Uri.parse(endpoint).buildUpon()
            .appendQueryParameter("client_id", client).appendQueryParameter("scope", scope)
            .appendQueryParameter("response_type", "code").appendQueryParameter("redirect_uri", redirect)
            .appendQueryParameter("state", state).appendQueryParameter("code_challenge", challenge)
            .appendQueryParameter("code_challenge_method", "S256").appendQueryParameter("prompt","select_account").build()
          withContext(Dispatchers.Main) { activity.startActivity(Intent(Intent.ACTION_VIEW, url)) }
          val deadline = SystemClock.elapsedRealtime() + 180000
          var code: String? = null
          while (code == null && SystemClock.elapsedRealtime() < deadline) {
            server.soTimeout = (deadline - SystemClock.elapsedRealtime()).coerceAtLeast(1).toInt()
            server.accept().use { socket ->
              socket.soTimeout = 3000
              try {
                val input = socket.getInputStream()
                val line = StringBuilder()
                while (line.length < 8192) {
                  val c = input.read()
                  if (c == -1 || c == 10) break
                  line.append(c.toChar())
                }
                val words = line.toString().trim().split(' ')
                val uri = Uri.parse(words.getOrNull(1) ?: "")
                val valid = words.firstOrNull() == "GET" && uri.path == "/" &&
                  state == uri.getQueryParameter("state") && uri.isRelative
                val reply = if (valid) "200 OK" else "404 Not Found"
                val body = if(valid) "Return to PutmanCode." else ""
                socket.getOutputStream().write(("HTTP/1.1 $reply\r\nContent-Type: text/plain\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: ${body.length}\r\n\r\n$body").toByteArray())
                if(valid) code = uri.getQueryParameter("code") ?: error("Microsoft sign-in was declined.")
              } catch (_: SocketTimeoutException) {
                // A browser can preconnect before issuing the callback request.
              }
            }
          }
          mapOf("code" to (code ?: error("Microsoft sign-in expired.")), "redirectUri" to redirect, "verifier" to verifier)
        }
      }
    }
  }
}
