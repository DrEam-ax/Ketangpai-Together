# WebView 的 JS 桥是通过反射调用的，混淆或裁剪会打断它 —— 这是最容易被 R8 干掉的部分。
# （Android 默认的 proguard 文件里其实有一条通用规则，这里再显式写一遍，免得依赖默认值。）
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class com.ktp.scanner.MainActivity$Bridge { *; }

# ML Kit 自带的 consumer rules 会处理它自己的反射，这里只压掉我们没用到部分的警告。
-dontwarn com.google.mlkit.**
-dontwarn com.google.android.gms.**
