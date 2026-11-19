const fs = require('node:fs/promises');
const path = require('node:path');
const {AndroidConfig, withAndroidManifest, withDangerousMod} = require('expo/config-plugins');

// Use the image tooling bundled with our installed Expo SDK; no separate native
// image library or package installation is needed during prebuild.
const {generateImageAsync} = require(require.resolve('@expo/image-utils', {
  paths: [path.dirname(require.resolve('expo/package.json'))],
}));

const densities = {mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192};

function setManifestIcons(manifest) {
  const application = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
  application.$['android:icon'] = '@mipmap/super_agent';
  application.$['android:roundIcon'] = '@mipmap/super_agent_round';
  return manifest;
}

async function writeIconResources(projectRoot, platformProjectRoot) {
  const assets = path.resolve(projectRoot, '../../assets/branding/android');
  const resources = path.join(platformProjectRoot, 'app/src/main/res');
  async function write(relative, value) {
    const file = path.join(resources, relative);
    await fs.mkdir(path.dirname(file), {recursive: true});
    await fs.writeFile(file, value);
  }

  for (const [appearance, qualifier, background] of [
    ['light', '', '#FFFFFF'], ['dark', '-night', '#202027'],
  ]) {
    await write(`values${qualifier}/super_agent_icon.xml`,
      `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n  <color name="super_agent_icon_background">${background}</color>\n</resources>\n`);
    await write(`drawable${qualifier}-nodpi/super_agent_foreground.png`,
      await fs.readFile(path.join(assets, `foreground-${appearance}.png`)));
    for (const [density, size] of Object.entries(densities)) {
      const {source} = await generateImageAsync({projectRoot, cacheType: 'super-agent-launcher'}, {
        src: path.join(assets, `icon-${appearance}.png`),
        width: size, height: size, resizeMode: 'contain', backgroundColor: 'transparent',
      });
      for (const name of ['super_agent', 'super_agent_round']) {
        await write(`mipmap${qualifier}-${density}/${name}.png`, source);
      }
    }
  }
  await write('drawable-nodpi/super_agent_monochrome.png',
    await fs.readFile(path.join(assets, 'monochrome.png')));
  for (const version of [26, 33]) {
    const xml = `<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n  <background android:drawable="@color/super_agent_icon_background"/>\n  <foreground android:drawable="@drawable/super_agent_foreground"/>\n${version >= 33 ? '  <monochrome android:drawable="@drawable/super_agent_monochrome"/>\n' : ''}</adaptive-icon>\n`;
    for (const name of ['super_agent', 'super_agent_round']) {
      await write(`mipmap-anydpi-v${version}/${name}.xml`, xml);
    }
  }
}

function withLauncherIcons(config) {
  config = withAndroidManifest(config, mod => {
    mod.modResults = setManifestIcons(mod.modResults);
    return mod;
  });
  return withDangerousMod(config, ['android', async mod => {
    await writeIconResources(mod.modRequest.projectRoot, mod.modRequest.platformProjectRoot);
    return mod;
  }]);
}

module.exports = withLauncherIcons;
module.exports.writeIconResources = writeIconResources;

// Apply only the icon changes to an already generated native project.
if (require.main === module) {
  const projectRoot = path.resolve(__dirname, '..');
  const platformProjectRoot = path.join(projectRoot, 'android');
  (async () => {
    await writeIconResources(projectRoot, platformProjectRoot);
    const manifestFile = path.join(platformProjectRoot, 'app/src/main/AndroidManifest.xml');
    const manifest = setManifestIcons(await AndroidConfig.Manifest.readAndroidManifestAsync(manifestFile));
    await AndroidConfig.Manifest.writeAndroidManifestAsync(manifestFile, manifest);
    console.log('Updated Android light, dark and themed launcher icons.');
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
