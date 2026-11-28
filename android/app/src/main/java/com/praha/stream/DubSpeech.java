package com.praha.stream;

import android.content.Context;
import android.speech.tts.TextToSpeech;
import java.util.Locale;

final class DubSpeech {
    private final Context context;
    private TextToSpeech engine;
    private boolean ready;
    private Runnable pending;

    DubSpeech(Context context) {
        this.context = context.getApplicationContext();
    }

    void speak(String text, String language, double rate) {
        if (text.isBlank() || text.length() > TextToSpeech.getMaxSpeechInputLength()) return;
        pending = () -> {
            engine.setLanguage(Locale.forLanguageTag(language));
            engine.setSpeechRate((float) Math.max(0.65, Math.min(rate, 2.0)));
            engine.speak(text, TextToSpeech.QUEUE_FLUSH, null, "praha-dub");
        };
        if (ready) {
            pending.run();
            pending = null;
        } else if (engine == null) {
            engine = new TextToSpeech(context, result -> {
                ready = result == TextToSpeech.SUCCESS;
                if (ready && pending != null) pending.run();
                pending = null;
            });
        }
    }

    void stop() {
        pending = null;
        if (engine != null) engine.stop();
    }

    void release() {
        stop();
        if (engine != null) engine.shutdown();
        engine = null;
        ready = false;
    }
}
