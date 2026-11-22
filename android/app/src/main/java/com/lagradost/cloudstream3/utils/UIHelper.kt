package com.lagradost.cloudstream3.utils

import android.app.Activity
import android.content.Context
import android.content.res.Resources
import android.view.View
import android.view.inputmethod.InputMethodManager
import androidx.appcompat.app.AlertDialog
import androidx.fragment.app.DialogFragment

/**
 * The official app's UIHelper, as far as extension settings screens use it.
 * Extensions call `UIHelper.hideKeyboard(...)` etc. from their settings
 * fragments; the helpers themselves are pure Android, so they port unchanged.
 */
object UIHelper {
    val Int.toPx: Int get() = (this * Resources.getSystem().displayMetrics.density).toInt()
    val Float.toPx: Float get() = this * Resources.getSystem().displayMetrics.density
    val Int.toDp: Int get() = (this / Resources.getSystem().displayMetrics.density).toInt()
    val Float.toDp: Float get() = this / Resources.getSystem().displayMetrics.density

    fun AlertDialog?.dismissSafe(activity: Activity?) {
        if (this?.isShowing == true && activity?.isFinishing == false) dismiss()
    }

    fun DialogFragment?.dismissSafe() {
        runCatching { this?.dismissAllowingStateLoss() }
    }

    fun hideKeyboard(view: View?) {
        view ?: return
        (view.context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)
            ?.hideSoftInputFromWindow(view.windowToken, 0)
    }

    fun showInputMethod(view: View?) {
        view ?: return
        (view.context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)
            ?.showSoftInput(view, 0)
    }
}
