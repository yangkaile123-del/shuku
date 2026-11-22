#!/bin/bash
# 书库 Android 客户端构建脚本（在 Termux / 本机 Android 工具链下测试通过）
# 依赖：aapt / javac / d8 / zipalign / apksigner，以及 $HOME/android.jar
set -e

# 需要时改这两行，或直接放到 PATH 里
export PATH="$PATH:/data/user/0/app.dsh.mobile/files/engine/extensions/android-buildtools/bin"
AJ="${ANDROID_JAR:-$HOME/android.jar}"

# 签名：默认读同目录的 keystore.jks，可用环境变量覆盖
KS="${KEYSTORE:-keystore.jks}"
KS_PASS="${KEYSTORE_PASS:-changeit}"
KEY_ALIAS="${KEY_ALIAS:-shelf}"
OUT="build/书库-${VERSION:-dev}.apk"

if [ ! -f src/com/fj/bookshelf/Conf.java ]; then
  echo "缺少 src/com/fj/bookshelf/Conf.java"
  echo "请先复制模板并填入你的服务器地址与密码："
  echo "  cp src/com/fj/bookshelf/Conf.java.example src/com/fj/bookshelf/Conf.java"
  exit 1
fi

rm -rf build && mkdir -p build/classes build/dex build/gen
echo "[1/6] aapt"
aapt package -f -M AndroidManifest.xml -S res -A assets \
  -I /system/framework/framework-res.apk -F build/unsigned.apk -J build/gen
echo "[2/6] javac"
find src -name "*.java" > build/srcs.txt
javac -source 8 -target 8 -nowarn -encoding UTF-8 -classpath "$AJ" -d build/classes build/gen/R.java @build/srcs.txt
echo "[3/6] d8"
d8 --lib "$AJ" --min-api 26 --output build/dex $(find build/classes -name "*.class")
echo "[4/6] add dex"
cp build/unsigned.apk build/dex/work.apk
(cd build/dex && aapt add -f work.apk classes.dex)
echo "[5/6] zipalign"
zipalign -f 4 build/dex/work.apk build/aligned.apk
echo "[6/6] sign"
apksigner sign --ks "$KS" --ks-pass "pass:$KS_PASS" --ks-key-alias "$KEY_ALIAS" \
  --min-sdk-version 26 --out "$OUT" build/aligned.apk
ls -la build/*.apk
