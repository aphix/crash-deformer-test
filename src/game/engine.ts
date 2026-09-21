    restoreBarrierRest(this.barrier);
    if (this.captureTrace) this.beginTrace();
    else {
      this.traceAcc = 0;
      this.traceSamples.length = 0;
      this.ballHits.length = 0;
      this.traceInitial = null;
    }
  }

  private beginTrace(): void {
    this.traceAcc = 0;
    this.traceSamples.length = 0;
    this.ballHits.length = 0;
    this.traceInitial = {
      barrier: this.showBarrier,
      barrierYaw: this.barrierYaw,
      squash: this.squash,
      buckle: this.buckle,
      fxDensity: this.fxDensity,
      balls: this.showBalls,
      compactor: this.showCompactor,
      compactFace: this.compactFace,
      carCount: this.carCount,
      speedMin: this.speedMin,
      speedMax: this.speedMax,
      cars: this.live().map((car) => ({
        paint: car.paint.name,
        spawn: {
          x: car.group.position.x,
          y: car.group.position.y,
          z: car.group.position.z,
        },
        yaw: car.yaw,
        speed: car.spawnSpeed,
        vel: { x: car.velocity.x, y: car.velocity.y, z: car.velocity.z },
      })),
    };
    this.pushTraceSample();
  }

  private pushTraceSample(): void {
    if (!this.captureTrace) return;
    if (this.traceSamples.length >= 96) return;
    this.traceSamples.push({
      t: Math.round(this.elapsedWall * 1000) / 1000,
      sim: Math.round(this.elapsedSim * 1000) / 1000,
      phase: this.phase,
      timeScale: Math.round(this.timeScale * 1000) / 1000,
      squash: this.squash,
      buckle: this.buckle,
      fxDensity: this.fxDensity,
      compactFace: round4(this.compactFace),
      compactStage: compactorStage(this.compactFace),
      closing: Math.round(this.fleetClosing() * 3.6 * 10) / 10,
      collision: {
        leftover: this.live().map((c) => round4(leftoverCrumple(c.deform.crumpleTravelCorner()))),
        transfer: this.live().map((c) => round4(c.deform.frontTransfer())),
        dist: round4(this.nearestPairDist()),
        barrierHit: this.barrierHits.some(Boolean),
        barrierCrush: round4(this.barrierCrush),
      },
      ballHits: this.ballHits,
      barrier: {
        pos: vec3(this.barrier.position),
        vel: vec3(this.barrierVel),
        yaw: round4(this.barrierYaw),
        crush: round4(this.barrierCrush),
        mass: BARRIER_MASS,
      },
      balls: this.balls.map((b) => ({
        intact: b.intact,
        radius: round4(b.radius),
        expose: BALL_EXPOSE,
        kicked: [...b.kicked],
        pos: vec3(b.mesh.position),
      })),
      particles: {
        sparks: this.sparks.snapshot(),
        smoke: this.smoke.snapshot(),
        debris: this.debris.snapshot(),
      },
      cars: this.live().map((c) => c.snapshot()),
    });
  }