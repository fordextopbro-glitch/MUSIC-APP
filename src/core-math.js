/* ═══════════════════════════════════════════════════════════════════
   §10  PART REGISTRATION
═══════════════════════════════════════════════════════════════════ */
Aqua.addPart('core-math', function initCoreMath(){
  /* shared singletons */
  if(!Aqua.bus){
    Aqua.bus = new EventBus();
  }
  if(!Aqua.flags){
    Aqua.flags = {
      glReady: false,
      audioReady: false,
      playing: false
    };
  }
  if(!Aqua.settings){
    const stored = Aqua.store.get('aqua.st', {});
    Aqua.settings = Object.assign({}, AConfig.settingsDefaults, stored);
  }

  /* expose convenience namespace */
  Aqua.math = {
    Vec3,
    Mat4,
    Quat,
    AColor,
    ARand,
    AFormat,
    AMath
  };
  Aqua.config = AConfig;

  /* persist helper */
  Aqua.saveSettings = function(){
    clearTimeout(Aqua.saveSettings._t);
    Aqua.saveSettings._t = setTimeout(() => {
      Aqua.store.set('aqua.st', Aqua.settings);
      try{ localStorage.setItem('aqua.theme', Aqua.settings.theme); }catch(e){}
    }, 250);
  };

  console.info('[Aqua] core-math ready — Vec3/Mat4/Quat/AColor/ARand/EventBus + config');
});

/* ═══════════════ PART: p02b_ambient.js ═══════════════ */
