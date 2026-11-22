package com.lagradost.cloudstream3.utils

import android.content.DialogInterface
import androidx.appcompat.app.AlertDialog

/**
 * The official app's AppContextUtils, as far as extensions use it.
 *
 * [loadResult] opens a title page in the official app. PRAHA's screens are HTML, so the
 * host asks the web layer to navigate instead — the same path every other deep link
 * takes. Extensions calling it get a working title page; nothing here casts or blocks.
 */
object AppContextUtils {
    /** Set by the host when the WebView exists; arguments are (apiName, url, name). */
    @Volatile
    var openDetails: ((apiName: String, url: String, name: String) -> Unit)? = null

    fun loadResult(url: String, apiName: String, name: String, startAction: Int = 0, startValue: Int = 0) {
        openDetails?.invoke(apiName, url, name)
    }

    fun AlertDialog.setDefaultFocus(buttonFlag: Int = DialogInterface.BUTTON_POSITIVE) {
        getButton(buttonFlag)?.run {
            isFocusableInTouchMode = true
            requestFocus()
        }
    }
}
