/* =========================================================================
   AmaNotícias — globo 3D do cabeçalho
   =========================================================================
   Um globo esquemático (paralelos e meridianos em wireframe) com pontos
   pulsantes marcando as cidades onde ficam as fontes de notícia agregadas
   pelo site. Não é um enfeite genérico: os pontos representam dados reais
   (as fontes configuradas no back-end), reforçando visualmente a proposta
   "notícias em tempo real, reunidas de várias fontes".

   Requer THREE.js (carregado via CDN no index.html, antes deste arquivo).
   Se a biblioteca não carregar (ex.: sem internet), o contêiner mantém o
   gradiente de fundo definido em CSS como estado visual de reserva.
   ========================================================================= */
(function () {
  'use strict';

  const container = document.getElementById('hero-globe');
  if (!container || typeof THREE === 'undefined') return;

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Cidades-sede das fontes de notícia agregadas pelo site (lat/lon aprox.).
  const SOURCES = [
    { name: 'G1 — Rio de Janeiro', lat: -22.9, lon: -43.2, live: true },
    { name: 'UOL — São Paulo', lat: -23.55, lon: -46.63 },
    { name: 'CNN Brasil — São Paulo', lat: -23.6, lon: -46.68 },
    { name: 'Agência Brasil — Brasília', lat: -15.79, lon: -47.88 },
  ];

  const RADIUS = 1.5;

  function latLonToVector3(lat, lon, radius) {
    const phi = (90 - lat) * (Math.PI / 180);
    const theta = (lon + 180) * (Math.PI / 180);
    return new THREE.Vector3(
      -radius * Math.sin(phi) * Math.cos(theta),
      radius * Math.cos(phi),
      radius * Math.sin(phi) * Math.sin(theta)
    );
  }

  function readColor(varName, fallback) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
    return value || fallback;
  }

  function makeGlowTexture(hex) {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, hex + 'aa');
    gradient.addColorStop(1, hex + '00');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    return new THREE.CanvasTexture(canvas);
  }

  let scene, camera, renderer, globe, pinGroup;
  let rafId = null;
  let pointerX = 0;
  let pointerY = 0;
  const clock = new THREE.Clock();

  function init() {
    const width = container.clientWidth || 240;
    const height = container.clientHeight || 240;

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(38, width / height, 0.1, 100);
    camera.position.set(0, 0.15, 5.2);

    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height);
    container.appendChild(renderer.domElement);

    const inkColor = readColor('--color-ink-soft', '#4c505f');
    const accentColor = readColor('--color-accent', '#d99a2b');
    const aiColor = readColor('--color-ai', '#5b5fef');
    const liveColor = readColor('--color-live', '#d64550');

    // Brilho de fundo ecoando os dois acentos do site (âmbar editorial + índigo da IA)
    const glow1 = new THREE.Sprite(new THREE.SpriteMaterial({
      map: makeGlowTexture(accentColor), transparent: true, depthWrite: false,
    }));
    glow1.scale.set(4.4, 4.4, 1);
    glow1.position.set(-0.6, 0.3, -1.5);
    scene.add(glow1);

    const glow2 = new THREE.Sprite(new THREE.SpriteMaterial({
      map: makeGlowTexture(aiColor), transparent: true, depthWrite: false, opacity: 0.7,
    }));
    glow2.scale.set(3.4, 3.4, 1);
    glow2.position.set(1, -0.4, -1.2);
    scene.add(glow2);

    // Esfera interna sólida e sutil, só pra dar volume ao globo
    const solidGeometry = new THREE.SphereGeometry(RADIUS - 0.02, 32, 24);
    const solidMaterial = new THREE.MeshBasicMaterial({ color: inkColor, transparent: true, opacity: 0.05 });
    scene.add(new THREE.Mesh(solidGeometry, solidMaterial));

    // Globo em wireframe (paralelos e meridianos)
    const wireGeometry = new THREE.SphereGeometry(RADIUS, 28, 18);
    const wireMaterial = new THREE.MeshBasicMaterial({ color: inkColor, wireframe: true, transparent: true, opacity: 0.4 });
    globe = new THREE.Mesh(wireGeometry, wireMaterial);
    globe.rotation.x = 0.22;
    globe.rotation.y = -0.6;
    scene.add(globe);

    // Anel externo, ecoando o "ponto ao vivo" do cabeçalho
    const ringGeometry = new THREE.RingGeometry(RADIUS + 0.14, RADIUS + 0.155, 64);
    const ringMaterial = new THREE.MeshBasicMaterial({ color: accentColor, transparent: true, opacity: 0.5, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(ringGeometry, ringMaterial);
    ring.rotation.x = Math.PI / 2.4;
    scene.add(ring);

    // Pontos das fontes de notícia, presos ao globo (giram junto)
    pinGroup = new THREE.Group();
    SOURCES.forEach((source, index) => {
      const position = latLonToVector3(source.lat, source.lon, RADIUS + 0.01);
      const pinMaterial = new THREE.MeshBasicMaterial({ color: source.live ? liveColor : accentColor });
      const pin = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 12), pinMaterial);
      pin.position.copy(position);
      pin.userData.phase = index * 1.1;
      pinGroup.add(pin);
    });
    globe.add(pinGroup);

    window.addEventListener('resize', onResize);
    container.addEventListener('pointermove', onPointerMove);
    container.addEventListener('pointerleave', onPointerLeave);
    document.addEventListener('visibilitychange', onVisibilityChange);

    animate();
  }

  function onResize() {
    if (!renderer) return;
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (!width || !height) return;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
  }

  function onPointerMove(event) {
    const rect = container.getBoundingClientRect();
    pointerX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointerY = ((event.clientY - rect.top) / rect.height) * 2 - 1;
  }

  function onPointerLeave() {
    pointerX = 0;
    pointerY = 0;
  }

  function onVisibilityChange() {
    if (document.hidden) {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = null;
    } else if (!rafId) {
      animate();
    }
  }

  function animate() {
    rafId = requestAnimationFrame(animate);
    const elapsed = clock.getElapsedTime();

    if (!prefersReducedMotion) {
      globe.rotation.y += 0.0022;
    }

    // Inclinação sutil seguindo o ponteiro — só responde ao gesto da pessoa
    const targetTiltX = 0.22 + pointerY * 0.12;
    const targetTiltZ = pointerX * 0.08;
    globe.rotation.x += (targetTiltX - globe.rotation.x) * 0.04;
    globe.rotation.z += (targetTiltZ - globe.rotation.z) * 0.04;

    pinGroup.children.forEach((pin) => {
      const pulse = prefersReducedMotion ? 1 : 1 + Math.sin(elapsed * 2 + pin.userData.phase) * 0.35;
      pin.scale.setScalar(pulse);
    });

    renderer.render(scene, camera);
  }

  // Só inicializa quando o cabeçalho entra na tela, pra não gastar recursos à toa
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting && !renderer) {
          init();
          observer.disconnect();
        }
      });
    }, { threshold: 0.1 });
    observer.observe(container);
  } else {
    init();
  }
})();