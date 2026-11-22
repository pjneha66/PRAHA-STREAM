package com.lagradost.cloudstream3

import com.getcapacitor.BridgeActivity
import com.lagradost.cloudstream3.utils.Event

/**
 * The official app's main activity, as far as extensions see it.
 *
 * Upstream this is `abstract class MainActivity : AppCompatActivity()`. Here it
 * extends Capacitor's [BridgeActivity], which is itself an `AppCompatActivity`,
 * so every AppCompatActivity contract still holds; PRAHA's real screen
 * (`com.praha.stream.MainActivity`) extends *this* class. That makes both of
 * these true at once, which is what extensions actually rely on:
 *
 *  - `activity is com.lagradost.cloudstream3.MainActivity`
 *  - the activity handed to extensions is a real, visible `AppCompatActivity`
 *
 * The companion carries the app events extensions fire and subscribe to
 * (StreamPlay, StremioX, Ultima…).
 */
abstract class MainActivity : BridgeActivity() {
    companion object {
        val afterPluginsLoadedEvent = Event<Boolean>()
        val mainPluginsLoadedEvent = Event<Boolean>()
        val mainPluginsLoadedEventTv = Event<Boolean>()
        val afterRepositoryLoadedEvent = Event<Boolean>()
        val bookmarksUpdatedEvent = Event<Boolean>()
        val reloadHomeEvent = Event<Boolean>()
        val reloadLibraryEvent = Event<Boolean>()
        val reloadAccountEvent = Event<Boolean>()
    }
}
