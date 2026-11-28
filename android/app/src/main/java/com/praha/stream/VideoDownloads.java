package com.praha.stream;

import android.app.Activity;
import android.app.Dialog;
import android.app.DownloadManager;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.widget.MediaController;
import android.widget.VideoView;
import android.widget.Toast;
import org.json.JSONObject;

final class VideoDownloads {
    private final Activity activity;

    VideoDownloads(Activity activity) {
        this.activity = activity;
    }

    JSONObject status(long id) throws Exception {
        DownloadManager manager = (DownloadManager) activity.getSystemService(Context.DOWNLOAD_SERVICE);
        String state = "missing";
        long bytes = 0;
        long total = 0;
        try (Cursor row = manager.query(new DownloadManager.Query().setFilterById(id))) {
            if (row != null && row.moveToFirst()) {
                state = switch (row.getInt(row.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))) {
                    case DownloadManager.STATUS_PENDING -> "queued";
                    case DownloadManager.STATUS_RUNNING -> "downloading";
                    case DownloadManager.STATUS_PAUSED -> "paused";
                    case DownloadManager.STATUS_SUCCESSFUL -> "complete";
                    case DownloadManager.STATUS_FAILED -> "failed";
                    default -> "missing";
                };
                bytes = row.getLong(row.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
                total = row.getLong(row.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES));
            }
        }
        return new JSONObject().put("state", state).put("bytes", bytes).put("total", total);
    }

    boolean perform(long id, String action) {
        if (id < 1) return false;
        DownloadManager manager = (DownloadManager) activity.getSystemService(Context.DOWNLOAD_SERVICE);
        if ("remove".equals(action)) {
            manager.remove(id);
            return true;
        }
        Uri uri = manager.getUriForDownloadedFile(id);
        if (uri == null) return false;
        if ("play".equals(action)) {
            activity.runOnUiThread(() -> play(uri));
            return true;
        }
        if ("share".equals(action)) {
            String mime = manager.getMimeTypeForDownloadedFile(id);
            Intent share = new Intent(Intent.ACTION_SEND)
                    .setType(mime == null ? "video/*" : mime)
                    .putExtra(Intent.EXTRA_STREAM, uri)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            share.setClipData(ClipData.newRawUri("Video", uri));
            activity.runOnUiThread(() -> activity.startActivity(Intent.createChooser(share, "Export video")));
            return true;
        }
        return false;
    }

    private void play(Uri uri) {
        Dialog dialog = new Dialog(activity, android.R.style.Theme_Material_NoActionBar_Fullscreen);
        VideoView video = new VideoView(activity);
        MediaController controls = new MediaController(activity);
        video.setMediaController(controls);
        dialog.setContentView(video);
        dialog.setOnDismissListener(ignored -> video.stopPlayback());
        video.setOnErrorListener((player, what, extra) -> {
            Toast.makeText(activity, "Android could not play this video format.", Toast.LENGTH_LONG).show();
            dialog.dismiss();
            return true;
        });
        dialog.show();
        video.setVideoURI(uri);
        video.start();
    }
}
