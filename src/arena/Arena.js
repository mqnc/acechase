
// depends on HBObject.js

var MAP_WIDTH;
var MAP_HEIGHT;
var MAP_MAXDIM;

// the distance map stores the distance to the coast for each pixel in it
// (positive in water and negative on land)
// used for collision detection with the coast and to see where objects
// can spawn randomly
var DISTANCE_MAP_POLY = {};
var DISTANCE_MAP_CURV = {};
var FOG_COLOR = new THREE.Color(0x808080);

var STD_TEX;

var ASL; // arena svg loader

// convert coast distance to terrain height
function d2h(d){return 3.0*Math.atan(0.5*d);}

// single color texture
function monotex(r, g, b, a){ // 0..255
	var ar = new Uint8ClampedArray(4*4*4);
	for(var i=0; i<ar.length; i+=4){
		ar[i  ] = 255;
		ar[i+1] = g;
		ar[i+2] = b;
		ar[i+3] = a;
	}
	return new THREE.Texture(array2canvas(ar, 4, 4));
}

// returns the distance from the coast (bilinear interpolation on distance map)
function coastDistance(x, y, curved){ // map center at (0,0), negative distance is in water, positive on land

	var DISTANCE_MAP = curved? DISTANCE_MAP_CURV : DISTANCE_MAP_POLY;

	// the -0.5 was found experimentally but it probably makes sense due to pixel centering and rounding and stuff :P TODO: overthink this
	var xhr = DISTANCE_MAP.w/2 + x*DISTANCE_MAP.f -0.5;
	var yhr = DISTANCE_MAP.h/2 - y*DISTANCE_MAP.f -0.5;

	if(xhr<0){xhr = 0;}
	if(xhr>DISTANCE_MAP.w-1.00001){xhr = DISTANCE_MAP.w-1.00001;}
	if(yhr<0){yhr = 0;}
	if(yhr>DISTANCE_MAP.h-1.00001){yhr = DISTANCE_MAP.h-1.00001;}

	var xint = Math.floor(xhr); // round part
	var yint = Math.floor(yhr);
	var xfrc = xhr - xint; // fraction
	var yfrc = yhr - yint;

	var d1 = DISTANCE_MAP.map[ yint   *DISTANCE_MAP.w+xint] * (1-xfrc) + DISTANCE_MAP.map[ yint   *DISTANCE_MAP.w+xint+1] * xfrc;
	var d2 = DISTANCE_MAP.map[(yint+1)*DISTANCE_MAP.w+xint] * (1-xfrc) + DISTANCE_MAP.map[(yint+1)*DISTANCE_MAP.w+xint+1] * xfrc;

	return (1-yfrc)*d1 + yfrc*d2;
}

function findAccessiblePosition(minCoastDistance){ // minCoastDistance must be negative for water

	var x=0;
	var y=0;
	var c=0;	
	var found = false;

	var trials = 1;
	while(!found && trials < 10000){
		x = (Math.random()-0.5)*MAP_WIDTH;
		y = (Math.random()-0.5)*MAP_HEIGHT;
		c = coastDistance(x, y, false);
		if(c <= minCoastDistance){
			found = true;
		}
		trials++;
	}
	if(trials == 10000){console.error("no point with desired coast distance found");}
	
	return new THREE.Vector2(x,y);
}

function Arena(filename){
	HBObject.call(this); // inheritance

	this.type = 'arena';

	// load SVG for contour

	LOADING_LIST.addItem('arena');

	//ArenaSvgLoader(filename, curvdpu, curvos, polydpu, polyos, callback){
	ASL = new ArenaSvgLoader(MAP, 4, 4, 4, 4, function(){ // to be executed when the svg is loaded:
		TEXTURE_LOADER.load('media/textures/stdtex.png', function(tex){ // to be executed when standard texture is loaded:
			STD_TEX = tex;
			STD_TEX.wrapS = THREE.RepeatWrapping;
			STD_TEX.wrapT = THREE.RepeatWrapping;

			MAP_WIDTH = ASL.svgw;
			MAP_HEIGHT = ASL.svgh;
		
			MAP_MAXDIM = Math.max(MAP_WIDTH, MAP_HEIGHT);

			// tile dimensions for collision detection broadphase:
			BROADPHASE.xmin = -MAP_WIDTH/2;
			BROADPHASE.xmax = MAP_WIDTH/2;
			BROADPHASE.ymin = -MAP_HEIGHT/2;
			BROADPHASE.ymax = MAP_HEIGHT/2;
			BROADPHASE.nx = 20;
			BROADPHASE.ny = 20;
			BROADPHASE.binsizeX = MAP_WIDTH/20;
			BROADPHASE.binsizeY = MAP_HEIGHT/20;

			// cut open the outline at the leftest point (smallestx)
			// the physics library can't deal with a shape that has a hole
			// so we turn it into one concave shape by turning an O into a C with a very tiny gap
			var smallestx = MAP_WIDTH;
			var ismallestx = -1;

			var poly = ASL.polygons;

			for(var ipt=0; ipt<poly[0].length; ipt++){
				if(poly[0][ipt][0] < smallestx){
					smallestx = poly[0][ipt][0];
					ismallestx = ipt;
				}
			}

			// find y values of the points before and after the incision
			var ybefore;
			var yafter;
			if(ismallestx == 0){
				ybefore = poly[0][poly[0].length-1][1];
				yafter  = poly[0][1][1];}
			else if(ismallestx == poly[0].length-1){
				ybefore = poly[0][ismallestx-1][1];
				yafter  = poly[0][0][1];}
			else{
				ybefore = poly[0][ismallestx-1][1];
				yafter  = poly[0][ismallestx+1][1];}

			// we have to draw the outer rim of the C (which will be a rectangle) in the
			// right direction or otherwise the incision lines will cross and the whole
			// thing will be a mess
			var dir = Math.sign(yafter-ybefore)>0;

			// insert incision and outer rectangle into the polygon:
			poly[0].splice(ismallestx+1, 0,
				[0, poly[0][ismallestx][1]],
				[0, dir?0:MAP_HEIGHT],
				[MAP_WIDTH, dir?0:MAP_HEIGHT],
				[MAP_WIDTH, dir?MAP_HEIGHT:0],
				[0, dir?MAP_HEIGHT:0],
				[0, poly[0][ismallestx][1]+(dir?1:-1)*0.01],
				[poly[0][ismallestx][0], poly[0][ismallestx][1]+(dir?1:-1)*0.01]);

			// make 0,0 the map center and invert y (svg coordinates start top left (eww)):
			for(var j=0; j<poly.length; j++){
				for(var i=0; i<poly[j].length; i++){
					poly[j][i][0] -= MAP_WIDTH/2;
					poly[j][i][1] = MAP_HEIGHT/2 - poly[j][i][1];
				}
			}

			// cornery distance map for physics and game engine:
			DISTANCE_MAP_POLY.f = ASL.polydpu; // resolution factor
			DISTANCE_MAP_POLY.w = MAP_WIDTH * ASL.polydpu;
			DISTANCE_MAP_POLY.h = MAP_HEIGHT * ASL.polydpu;
			DISTANCE_MAP_POLY.map = ASL.polydistancemap;

			// curved distance map for graphics (water and height field)
			DISTANCE_MAP_CURV.f = ASL.curvdpu; // resolution factor
			DISTANCE_MAP_CURV.w = MAP_WIDTH * ASL.curvdpu;
			DISTANCE_MAP_CURV.h = MAP_HEIGHT * ASL.curvdpu;
			DISTANCE_MAP_CURV.map = ASL.curvdistancemap;

			// draw border lines
			if(DEBUG >= 2){
				for(var iil=0; iil<poly.length; iil++){
					var material = new THREE.LineBasicMaterial({color: 0x00ffff});
					var geometry = new THREE.Geometry();

					for(var ipt=0; ipt<poly[iil].length; ipt++){
						geometry.vertices.push(new THREE.Vector3(poly[iil][ipt][0], poly[iil][ipt][1], 0.01));
					}
					geometry.vertices.push(new THREE.Vector3(poly[iil][0][0], poly[iil][0][1], 0.01));

					var line = new THREE.Line(geometry, material);
					GRAPHICS_SCENE.add(line);
				}
			}

			// generate phyisics engine polygons
			for(var iil=0; iil<poly.length; iil++){
				var body = new p2.Body({mass:0, position:[0,0]});
				body.fromPolygon(poly[iil]);
				
				for (var i=0; i<body.shapes.length; i++) {
					body.shapes[i].material = MAP_MATERIAL;

					if(DEBUG >= 3){ // draw convex shape decomposition
						var material = new THREE.LineBasicMaterial({color: 0xff8000});
						var geometry = new THREE.Geometry();

						for(var ipt=0; ipt<body.shapes[i].vertices.length; ipt++){
							geometry.vertices.push(new THREE.Vector3(
								body.shapes[i].vertices[ipt][0]+body.shapeOffsets[i][0]+body.position[0],
								body.shapes[i].vertices[ipt][1]+body.shapeOffsets[i][1]+body.position[1],
								0.01));
						}
						geometry.vertices.push(new THREE.Vector3(
							body.shapes[i].vertices[0][0]+body.shapeOffsets[i][0]+body.position[0],
							body.shapes[i].vertices[0][1]+body.shapeOffsets[i][1]+body.position[1],
							0.01));

						var line = new THREE.Line(geometry, material);
						GRAPHICS_SCENE.add(line);
					}
				}
				body.inDistanceMap = true;
				body.HBO = this;
				PHYSICS_WORLD.addBody(body);
			}

			// create terrain mesh
			var geometry = new THREE.PlaneGeometry( MAP_WIDTH, MAP_HEIGHT, MAP_WIDTH*4, MAP_HEIGHT*4);
			var normals = new Array(geometry.vertices.length);
			var x,y,O,N,E,S,W,dzdx,dzdy;
			var h = 1;

			for(var iv=0; iv<geometry.vertices.length; iv++){
				x = geometry.vertices[iv].x;
				y = geometry.vertices[iv].y;

				O = d2h(coastDistance(x, y,   true));
				N = d2h(coastDistance(x, y+h, true));
				S = d2h(coastDistance(x, y-h, true));
				E = d2h(coastDistance(x+h, y, true));
				W = d2h(coastDistance(x-h, y, true));

				geometry.vertices[iv].z = O;
				dzdx = (E - W)/2/h;
				dzdy = (N - S)/2/h;
				normals[iv] = new THREE.Vector3(-dzdx, -dzdy, 1).normalize();
			}
			for(var i=0; i<geometry.faces.length; i++){
				geometry.faces[i].vertexNormals[0] = normals[geometry.faces[i].a];
				geometry.faces[i].vertexNormals[1] = normals[geometry.faces[i].b];
				geometry.faces[i].vertexNormals[2] = normals[geometry.faces[i].c];
			}
			
			//geometry.computeFaceNormals();
			//geometry.computeVertexNormals(false);

			// prepare textures
			var diffstruct = ASL.gettex('diffusemap');
			var bumpstruct = ASL.gettex('normalmap');
			if(bumpstruct == null){
				bumpstruct = ASL.gettex('bumpmap');
				if(bumpstruct != null){ // convert bumpmap to normal map

				}
			}
			var specstruct = ASL.gettex('specularmap');
			var overstruct = ASL.gettex('overlay');

			if(diffstruct == null && bumpstruct == null && specstruct == null){
				diffstruct = {tex:STD_TEX, pos:new THREE.Vector4(0,0,5,5), tfinv:new THREE.Vector4(1,0,0,1)};
				bumpstruct = diffstruct;
				specstruct = diffstruct;
			}
			else{
				if(diffstruct == null){
					diffstruct = {tex:monotex(150,200,250,255), pos:new THREE.Vector4(0,0,1,1), tfinv:new THREE.Vector4(1,0,0,1)};}
				if(bumpstruct == null){
					bumpstruct = {tex:monotex(128,128,255,255), pos:new THREE.Vector4(0,0,1,1), tfinv:new THREE.Vector4(1,0,0,1)};}
				if(specstruct == null){
					specstruct = {tex:monotex(100,100,100,255), pos:new THREE.Vector4(0,0,1,1), tfinv:new THREE.Vector4(1,0,0,1)};}
			}
			if(overstruct == null){
				overstruct = {tex:monotex(0,0,0,0), pos:new THREE.Vector4(0,0,1,1), tfinv:new THREE.Vector4(1,0,0,1)};}

			if(ASL.getstyle("fog", "fill") != null){
				FOG_COLOR = new THREE.Color(ASL.getstyle("fog", "fill"));
			}
			WATER_COLOR = new THREE.Color(ASL.getstyle("outline", "fill"));
			WATER_OPACITY = ASL.getstyle("outline", "fillOpacity");

			var material = new THREE.ShaderMaterial( {
				uniforms: {
					lightvec:   { type: 'v3', value: LIGHT_VECTOR }, // direction towards light
					terraindims:{ type: 'v2', value: new THREE.Vector2(MAP_WIDTH, MAP_HEIGHT) },
					difftex:    { type: 't',  value: diffstruct.tex },
					difftexpos: { type: 'v4', value: diffstruct.pos },
					difftextf:  { type: 'v4', value: diffstruct.tfinv },
					bumptex:    { type: 't',  value: bumpstruct.tex },
					bumptexpos: { type: 'v4', value: bumpstruct.pos },
					bumptextf:  { type: 'v4', value: bumpstruct.tfinv },
					spectex:    { type: 't',  value: specstruct.tex },
					spectexpos: { type: 'v4', value: specstruct.pos },
					spectextf:  { type: 'v4', value: specstruct.tfinv },
					overtex:    { type: 't',  value: overstruct.tex },
					overtexpos: { type: 'v4', value: overstruct.pos },
					overtextf:  { type: 'v4', value: overstruct.tfinv },
					watercolor: { type: 'c' , value: WATER_COLOR }
				},
				vertexShader: `

					uniform vec2 terraindims;
					uniform vec3 lightvec;

					varying vec3 nml;
					varying vec3 light;
					varying vec3 view;

					uniform vec4 difftexpos;
					uniform vec4 difftextf;
					varying vec2 diffuv;
					uniform vec4 bumptexpos;
					uniform vec4 bumptextf;
					varying vec2 bumpuv;
					uniform vec4 spectexpos;
					uniform vec4 spectextf;
					varying vec2 specuv;
					uniform vec4 overtexpos;
					uniform vec4 overtextf;
					varying vec2 overuv;

					vec2 tfuv(vec4 p, vec4 tf){
						vec2 svguv = vec2(uv.x, 1.0-uv.y) * terraindims;
						mat2 tfmtx = mat2(tf.xy, tf.zw);
						vec2 texuv = (tfmtx * svguv - p.xy) / p.zw;
						texuv.y = 1.0-texuv.y;
						return texuv;
					}

					void main() {
						nml = normal;
						light = normalize(lightvec);
						view = position-cameraPosition;

						diffuv = tfuv(difftexpos, difftextf);
						bumpuv = tfuv(bumptexpos, bumptextf);
						specuv = tfuv(spectexpos, spectextf);
						overuv = tfuv(overtexpos, overtextf);

						gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
					}`,

				fragmentShader: `

					varying vec3 nml;
					varying vec3 light;
					varying vec3 view;

					uniform sampler2D difftex;
					uniform sampler2D bumptex;
					uniform sampler2D spectex;
					uniform sampler2D overtex;

					varying vec2 diffuv;
					varying vec2 bumpuv;
					varying vec2 specuv;
					varying vec2 overuv;

					void main()	{

						vec4 diff = texture2D( difftex, diffuv );
						vec3 bump = texture2D( bumptex, bumpuv ).xyz*2.0-1.0;
						float spec = texture2D( spectex, specuv ).y;
						vec3 nnml = normalize(nml); // necessary since the normals shorten during interpolation between vertices
						vec4 over = texture2D( overtex, overuv );

						vec2 dhdxy = nnml.xy/nnml.z + bump.xy/bump.z;
						vec3 nunml = normalize(vec3(dhdxy, 1.0));

						float wdiff = clamp(dot(nunml, light), 0.2, 1.0);
						float wspecular = pow(clamp(dot(reflect(normalize(view), nunml), light), 0.0, 1.0), 8.0) * spec;

						gl_FragColor = vec4(
							over.xyz * over.w +
							(1.0-over.w)*(
								wspecular * vec3(1.0) + 
								(1.0-wspecular) * wdiff * diff.xyz
							)
						, 1.0);

					}`
				} );

			// always in background
			material.depthWrite = false;
			material.transparent = true;
			this.mesh = new THREE.Mesh(geometry, material );
			this.mesh.renderOrder = RENDER_ORDER.terrain;
			GRAPHICS_SCENE.add( this.mesh );

			initWater();

			LOADING_LIST.checkItem('arena');
		});
	});

}

Arena.prototype = Object.create(HBObject.prototype);
Arena.prototype.constructor = Arena;

