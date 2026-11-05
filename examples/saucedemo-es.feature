# language: es
@url:https://www.saucedemo.com/
Característica: Sauce Demo en español

  Escenario: Un usuario bloqueado no puede iniciar sesión
    Cuando intento iniciar sesión como "locked_out_user" con la contraseña "secret_sauce"
    Entonces el error debería decir "Sorry, this user has been locked out."

  Escenario: Ordenar por precio muestra primero el producto más barato
    Cuando inicio sesión como "standard_user" con la contraseña "secret_sauce"
    Y ordeno los productos por "Price (low to high)"
    Entonces el precio del primer producto debería ser "$7.99"

  Escenario: El carrito cuenta los productos añadidos
    Cuando inicio sesión como "standard_user" con la contraseña "secret_sauce"
    Y añado "Sauce Labs Backpack" al carrito
    Y añado "Sauce Labs Bike Light" al carrito
    Entonces el icono del carrito debería mostrar "2"

  Escenario: El pago exige un nombre y luego se completa
    Cuando inicio sesión como "standard_user" con la contraseña "secret_sauce"
    Y añado "Sauce Labs Backpack" al carrito
    Y abro el carrito
    Y empiezo el pago
    Y intento continuar sin rellenar el formulario
    Entonces el error debería decir "First Name is required"
    Cuando escribo "Ada" como nombre, "Lovelace" como apellido y "10115" como código postal
    Y continúo
    Entonces el total de artículos debería ser "$29.99"
    Cuando termino el pedido
    Entonces debería ver "Thank you for your order!"
