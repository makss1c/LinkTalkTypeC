import type { ExpoConfig } from 'expo/config';

/**
 * LinkTalk — только Android.
 * Разработчик: makss1c (https://t.me/makss1c, makss.1c@yandex.ru)
 * Основано на Talktome (thepoison606), Apache License 2.0.
 */
const config: ExpoConfig = {
  name: 'LinkTalk',
  slug: 'linktalk',
  version: process.env.LINKTALK_MOBILE_VERSION || '1.1.0',
  orientation: 'default',
  icon: './assets/icon.png',
  userInterfaceStyle: 'dark',
  scheme: 'linktalk',
  platforms: ['android'],
  android: {
    // В Java-пакетах нельзя дефис.
    package: process.env.LINKTALK_ANDROID_PACKAGE || 'com.makss1c.linktalk',
    versionCode: Number(process.env.LINKTALK_MOBILE_BUILD_NUMBER || 1),
    adaptiveIcon: {
      backgroundColor: '#000000',
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
      monochromeImage: './assets/android-icon-monochrome.png',
    },
    permissions: [
      'RECORD_AUDIO',
      'MODIFY_AUDIO_SETTINGS',
      'INTERNET',
      'FOREGROUND_SERVICE',
      'FOREGROUND_SERVICE_MICROPHONE',
      'FOREGROUND_SERVICE_MEDIA_PLAYBACK',
      'FOREGROUND_SERVICE_CONNECTED_DEVICE',
      'POST_NOTIFICATIONS',
      'WAKE_LOCK',
      'VIBRATE',
      'BLUETOOTH',
      'BLUETOOTH_ADMIN',
      'BLUETOOTH_SCAN',
      'BLUETOOTH_CONNECT',
      'ACCESS_FINE_LOCATION',
      'CAMERA',
    ],
    predictiveBackGestureEnabled: false,
  },
  plugins: [
    '@preeternal/react-native-cookie-manager',
    [
      '@config-plugins/react-native-webrtc',
      {
        cameraPermission: 'LinkTalk использует камеру для сканирования QR-кодов сервера и входа.',
        microphonePermission: 'LinkTalk использует микрофон, чтобы вы могли говорить с абонентами.',
      },
    ],
    './plugins/withTalkToMeJitsiWebrtc',
    './plugins/withTalkToMeFgs',
    [
      'expo-camera',
      {
        cameraPermission: 'LinkTalk использует камеру для сканирования QR-кодов сервера и входа.',
        recordAudioAndroid: false,
        barcodeScannerEnabled: true,
      },
    ],
    './plugins/withTalkToMeBle',
    './plugins/withTalkToMeOrientation',
    [
      'expo-splash-screen',
      {
        backgroundColor: '#000000',
        image: './assets/splash-icon.png',
        resizeMode: 'contain',
        imageWidth: 200,
      },
    ],
    './plugins/withTalkToMeSplash',
    './plugins/withTalkToMeAndroidIcons',
  ],
};

export default config;
