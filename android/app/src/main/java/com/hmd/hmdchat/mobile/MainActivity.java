package com.hmd.hmdchat.mobile;

import android.content.Intent;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        PeerRuntime.getInstance(this).start();
        PeerRuntime.getInstance(this).importShareIntent(getIntent());
    }

    @Override
    public void onStart() {
        super.onStart();
        PeerRuntime.getInstance(this).start();
        PeerRuntime.getInstance(this).importShareIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        PeerRuntime.getInstance(this).start();
        PeerRuntime.getInstance(this).importShareIntent(intent);
    }
}
