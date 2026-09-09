/* Local deformation of the composited portrait. Facial patches move together
 * with the head; feet and regions outside the authored supports stay planted. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionTorsoRenderer = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function create(size = 1000, onAvailabilityChange = null) {
    const canvas = document.createElement('canvas');
    const dimension = Number.isInteger(size) && size > 0 ? size : 1000;
    canvas.width = canvas.height = dimension;
    let gl = null, program = null, buffer = null, texture = null;
    let ready = false, hasArt = false, disposed = false, currentConfig = null;
    let uniforms = null;

    function unavailable(event) {
      // The caller falls back to the unchanged artwork when the GPU is lost.
      if (event) event.preventDefault();
      const wasReady = ready;
      ready = hasArt = false;
      if (wasReady && typeof onAvailabilityChange === 'function') queueMicrotask(onAvailabilityChange);
    }
    canvas.addEventListener('webglcontextlost', unavailable, false);

    function shader(type, source) {
      const value = gl.createShader(type);
      gl.shaderSource(value, source);
      gl.compileShader(value);
      if (!gl.getShaderParameter(value, gl.COMPILE_STATUS)) {
        gl.deleteShader(value);
        throw new Error('Torso shader unavailable: '+gl.getShaderInfoLog(value));
      }
      return value;
    }

    try {
      gl = canvas.getContext('webgl', {
        alpha: true, premultipliedAlpha: true, antialias: false,
        depth: false, stencil: false, preserveDrawingBuffer: true,
      });
      if (!gl || dimension > gl.getParameter(gl.MAX_TEXTURE_SIZE)) {
        throw new Error('Torso canvas unavailable');
      }
      const highp = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
      // Accurate texture coordinates keep stationary fur and transparent edges
      // stable. A static portrait is preferable on devices without highp.
      if (!highp || highp.precision === 0) throw new Error('Texture precision unavailable');
      const vertex = shader(gl.VERTEX_SHADER, `
        attribute vec2 a_position;
        varying highp vec2 v_uv;
        void main() {
          gl_Position = vec4(a_position, 0.0, 1.0);
          // Canvas coordinates run from the top down, unlike clip coordinates.
          v_uv = vec2(a_position.x * 0.5 + 0.5, 0.5 - a_position.y * 0.5);
        }
      `);
      let fragment;
      try {
        fragment = shader(gl.FRAGMENT_SHADER, `
          precision highp float;
          varying highp vec2 v_uv;
          uniform sampler2D u_art;
          uniform vec2 u_center;
          uniform vec2 u_radius;
          uniform float u_rise;
          uniform float u_expansion;
          uniform float u_level;
          uniform vec2 u_headPivot;
          uniform vec2 u_headBand;
          uniform vec2 u_headX;
          uniform float u_headAngle;
          uniform float u_headLift;
          uniform vec2 u_tailPivot;
          uniform vec2 u_tailTip;
          uniform vec2 u_tailCenter;
          uniform vec2 u_tailRadius;
          uniform vec2 u_tailAxis;
          uniform vec2 u_tailClipX;
          uniform float u_tailOffset;
          uniform float u_tailLevel;
          uniform vec4 u_tailHinge;
          uniform vec4 u_tailBoundaryA;
          uniform vec4 u_tailBoundaryB;
          uniform vec4 u_tailBoundaryC;
          float seamSegment(vec2 a, vec2 b, float y) {
            return mix(a.y,b.y,clamp((y-a.x)/(b.x-a.x),0.0,1.0));
          }
          float tailBoundary(float y) {
            if(y<=u_tailBoundaryA.z) return seamSegment(u_tailBoundaryA.xy,u_tailBoundaryA.zw,y);
            if(y<=u_tailBoundaryB.x) return seamSegment(u_tailBoundaryA.zw,u_tailBoundaryB.xy,y);
            if(y<=u_tailBoundaryB.z) return seamSegment(u_tailBoundaryB.xy,u_tailBoundaryB.zw,y);
            if(y<=u_tailBoundaryC.x) return seamSegment(u_tailBoundaryB.zw,u_tailBoundaryC.xy,y);
            return seamSegment(u_tailBoundaryC.xy,u_tailBoundaryC.zw,y);
          }
          void main() {
            vec2 source = v_uv;
            // Inverse maps are applied to one composite, never to detached eyes.
            float headWeight = (1.0 - smoothstep(u_headBand.x,u_headBand.y,source.y))
                             * (1.0 - smoothstep(u_headX.x,u_headX.y,source.x));
            float a = -u_headAngle * headWeight;
            vec2 d = source - u_headPivot + vec2(0.0,u_headLift * headWeight);
            source = u_headPivot + vec2(cos(a)*d.x-sin(a)*d.y,sin(a)*d.x+cos(a)*d.y);
            if (abs(u_tailLevel) > 0.0 && u_tailOffset > 0.0) {
              vec2 axis = u_tailTip - u_tailPivot;
              float along = dot(source-u_tailPivot,axis) / dot(axis,axis);
              vec2 localTail = (source-u_tailCenter) / u_tailRadius;
              float support = 1.0-smoothstep(0.55,1.0,dot(localTail,localTail));
              // Hinged tails are composited as separate source layers below.
              if(u_tailHinge.z<=0.0) {
                float tailWindow = support * smoothstep(u_tailAxis.x,u_tailAxis.y,along)
                  * smoothstep(u_tailClipX.x,u_tailClipX.y,source.x);
                vec2 normal = normalize(vec2(-axis.y,axis.x));
                source -= normal * (u_tailOffset*u_tailLevel*tailWindow);
              }
            }
            vec2 delta = source - u_center;
            vec2 local = delta / u_radius;
            float distanceSquared = dot(local, local);
            if (distanceSquared < 1.0 && u_level > 0.0) {
              // A broad, softly fading center moves the chest outline together
              // with its fur instead of sliding only the interior texture.
              float weight = 1.0 - smoothstep(0.25, 1.0, distanceSquared);
              vec2 displacement = vec2(delta.x * u_expansion, -u_rise);
              source -= displacement * (u_level * weight);
            }
            // The uploaded texture is premultiplied, as is the canvas output.
            vec4 original=texture2D(u_art,source);
            if(u_tailHinge.z>0.0 && abs(u_tailLevel)>0.0) {
              // The body remains fixed. The tail mask travels WITH its source
              // pixels, allowing the whole tail to pass behind the haunch.
              vec2 localBody=(source-u_tailCenter)/u_tailRadius;
              float bodySupport=1.0-smoothstep(.9,1.0,dot(localBody,localBody));
              float bodySeam=tailBoundary(source.y);
              float cut=smoothstep(bodySeam,bodySeam+u_tailHinge.w*.5,source.x)*bodySupport;
              vec4 body=original*(1.0-cut);
              float angle=-u_tailHinge.z*u_tailLevel;
              vec2 offset=source-u_tailHinge.xy;
              vec2 tailSource=u_tailHinge.xy+vec2(cos(angle)*offset.x-sin(angle)*offset.y,
                                                 sin(angle)*offset.x+cos(angle)*offset.y);
              vec2 localTail=(tailSource-u_tailCenter)/u_tailRadius;
              float tailSupport=1.0-smoothstep(.9,1.0,dot(localTail,localTail));
              float tailSeam=tailBoundary(tailSource.y);
              float overlap=smoothstep(u_tailBoundaryA.z,u_tailBoundaryB.x,tailSource.y);
              float tailMask=smoothstep(tailSeam-u_tailHinge.w*2.5*overlap,tailSeam+u_tailHinge.w*.5-u_tailHinge.w*overlap,tailSource.x)*tailSupport;
              vec4 tail=texture2D(u_art,tailSource)*tailMask;
              vec4 layered=body+tail*(1.0-body.a);
              gl_FragColor=mix(original,layered,smoothstep(0.0,.02,abs(u_tailLevel)));
            } else gl_FragColor=original;
          }
        `);
      } catch (error) {
        gl.deleteShader(vertex);
        throw error;
      }
      program = gl.createProgram();
      gl.attachShader(program, vertex);
      gl.attachShader(program, fragment);
      gl.linkProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Torso program unavailable');
      gl.useProgram(program);
      buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const position = gl.getAttribLocation(program, 'a_position');
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      uniforms = {};
      ['art', 'center', 'radius', 'rise', 'expansion', 'level', 'headPivot', 'headBand', 'headX', 'headAngle', 'headLift', 'tailPivot', 'tailTip', 'tailCenter', 'tailRadius', 'tailAxis', 'tailClipX', 'tailOffset', 'tailLevel', 'tailHinge', 'tailBoundaryA', 'tailBoundaryB', 'tailBoundaryC'].forEach(name => {
        uniforms[name] = gl.getUniformLocation(program, 'u_' + name);
      });
      texture = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.uniform1i(uniforms.art, 0);
      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.DITHER);
      gl.viewport(0, 0, dimension, dimension);
      ready = true;
    } catch (error) {
      if(location.hostname==='127.0.0.1')console.warn(String(error));
      ready = false;
    }

    function copyConfig(value) {
      if (!value || !Array.isArray(value.center) || value.center.length !== 2 ||
          !Array.isArray(value.radius) || value.radius.length !== 2 ||
          !value.center.every(Number.isFinite) || !value.radius.every(Number.isFinite) ||
          !value.radius.every(number => number > 0) ||
          !Number.isFinite(value.rise) || !Number.isFinite(value.expansion)) return null;
      const pair = a => Array.isArray(a) && a.length===2 && a.every(Number.isFinite);
      const h=value.head, t=value.tail;
      if(h && (!pair(h.pivot)||!pair(h.neckBand)||!pair(h.xFade)||!Number.isFinite(h.maxTiltDegrees)||!Number.isFinite(h.maxBob))) return null;
      if(t && (!['pivot','tip','center','radius','axisFade','clipX'].every(k=>pair(t[k]))||!Number.isFinite(t.maxTipOffset))) return null;
      if(t?.hinge){const v=t.hinge;if(!pair(v.pivot)||!Number.isFinite(v.feather)||v.feather<=0||!Number.isFinite(v.maxAngleDegrees)||v.maxAngleDegrees<0||v.maxAngleDegrees>10||!Array.isArray(v.boundary)||v.boundary.length!==6||!v.boundary.every((p,i)=>pair(p)&&(!i||p[0]>v.boundary[i-1][0])))return null;}
      return { center: value.center.slice(), radius: value.radius.slice(), rise: value.rise, expansion: value.expansion,
        head:h?JSON.parse(JSON.stringify(h)):null, tail:t?JSON.parse(JSON.stringify(t)):null };
    }

    return {
      get available() { return ready && !disposed && !gl.isContextLost(); },
      get config() { return currentConfig ? copyConfig(currentConfig) : null; },
      setArt(baseCanvas, config) {
        hasArt = false;
        currentConfig = null;
        if (!this.available || !baseCanvas || baseCanvas.width !== dimension || baseCanvas.height !== dimension) return false;
        const next = copyConfig(config);
        if (!next) return false;
        try {
          gl.useProgram(program);
          gl.bindTexture(gl.TEXTURE_2D, texture);
          // Upload once per selected companion, never in the animation loop.
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, baseCanvas);
          if (gl.getError() !== gl.NO_ERROR) throw new Error('Torso texture unavailable');
          gl.uniform2fv(uniforms.center, next.center);
          gl.uniform2fv(uniforms.radius, next.radius);
          gl.uniform1f(uniforms.rise, next.rise);
          gl.uniform1f(uniforms.expansion, next.expansion);
          const h=next.head||{pivot:[0,0],neckBand:[-2,-1],xFade:[2,3]};
          const t=next.tail||{pivot:[0,0],tip:[1,0],center:[0,0],radius:[1,1],axisFade:[0,1],clipX:[-2,-1],maxTipOffset:0};
          gl.uniform2fv(uniforms.headPivot,h.pivot);gl.uniform2fv(uniforms.headBand,h.neckBand);gl.uniform2fv(uniforms.headX,h.xFade);
          gl.uniform2fv(uniforms.tailPivot,t.pivot);gl.uniform2fv(uniforms.tailTip,t.tip);gl.uniform2fv(uniforms.tailCenter,t.center);
          gl.uniform2fv(uniforms.tailRadius,t.radius);gl.uniform2fv(uniforms.tailAxis,t.axisFade);gl.uniform2fv(uniforms.tailClipX,t.clipX);
          gl.uniform1f(uniforms.tailOffset,t.maxTipOffset);
          const hinge=t.hinge,rows=hinge?.boundary||[[0,0],[.1,0],[.2,0],[.3,0],[.4,0],[.5,0]];
          gl.uniform4fv(uniforms.tailHinge,hinge?[...hinge.pivot,hinge.maxAngleDegrees*Math.PI/180,hinge.feather]:[0,0,0,0]);
          gl.uniform4fv(uniforms.tailBoundaryA,[...rows[0],...rows[1]]);
          gl.uniform4fv(uniforms.tailBoundaryB,[...rows[2],...rows[3]]);
          gl.uniform4fv(uniforms.tailBoundaryC,[...rows[4],...rows[5]]);
          currentConfig = next;
          hasArt = true;
          return true;
        } catch (_) {
          unavailable();
          return false;
        }
      },
      updateArt(composite) {
        if (!this.available || !hasArt) return false;
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,gl.RGBA,gl.UNSIGNED_BYTE,composite);
        return true;
      },
      render(level, pose={head:0,tail:0,lift:0}) {
        const head=Number.isFinite(pose.head)?pose.head:0,tail=Number.isFinite(pose.tail)?pose.tail:0,lift=Number.isFinite(pose.lift)?pose.lift:0;
        if (!this.available || !hasArt || !Number.isFinite(level) || (level<=0 && head===0 && tail===0 && lift===0)) return null;
        try {
          gl.uniform1f(uniforms.level, Math.min(1, Math.max(0,level)));
          gl.uniform1f(uniforms.headAngle,head*(currentConfig.head?.maxTiltDegrees||0)*Math.PI/180);
          gl.uniform1f(uniforms.headLift,lift*(currentConfig.head?.maxBob||0));
          gl.uniform1f(uniforms.tailLevel,tail);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
          return canvas;
        } catch (_) {
          unavailable();
          return null;
        }
      },
      destroy() {
        if (disposed) return;
        disposed = true;
        unavailable();
        canvas.removeEventListener('webglcontextlost', unavailable, false);
        if (gl) {
          if (texture) gl.deleteTexture(texture);
          if (buffer) gl.deleteBuffer(buffer);
          if (program) gl.deleteProgram(program);
          const release = gl.getExtension('WEBGL_lose_context');
          if (release) release.loseContext();
        }
        texture = buffer = program = null;
      },
    };
  }
  return { create };
});
